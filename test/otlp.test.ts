import http from 'node:http';
import net from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { createOtlpSender } from '../src/events/otlp.js';
import { MCP_SERVER_CALL, RUNNER_RUN_START } from '../src/events/event-names.js';
import type { Event } from '../src/schema/index.js';

function validEvent(): Event {
  return {
    agent: 'claude-code',
    session_id: 'session-1',
    project: 'agent-telemetry-abcd1234',
    kind: 'mcp_server_call',
    'mcp_server.call_id': '01HZCALL00000000000000001',
    'mcp.method.name': 'tools/call',
    'gen_ai.tool.name': 'probe',
    'mcp_server.total_ms': 120,
    'mcp_server.status': 'ok',
  };
}

function invalidEvent(): Event {
  return {
    agent: 'claude-code',
    session_id: 'session-1',
    project: 'agent-telemetry-abcd1234',
    kind: 'run_start',
    rep: -1,
  };
}

async function listenOnEphemeralPort(server: net.Server | http.Server): Promise<number> {
  await new Promise<void>((resolve) => {
    server.listen(0, resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected an AddressInfo');
  }
  return address.port;
}

describe('createOtlpSender, endpoint unset', () => {
  it('makes no network call and reports enabled false when the endpoint is unset', async () => {
    const fetchImpl = vi.fn();
    const sender = createOtlpSender({
      serviceName: 'test-service',
      env: {},
      fetchImpl,
      installSignalHandlers: false,
    });

    sender.emit(validEvent(), MCP_SERVER_CALL);
    await sender.flush();

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(sender.enabled).toBe(false);
  });
});

describe('createOtlpSender, real sockets', () => {
  it('resolves flush normally when nothing listens on the target port', async () => {
    const server = net.createServer();
    const port = await listenOnEphemeralPort(server);
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });

    const sender = createOtlpSender({
      serviceName: 'test-service',
      env: { OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${String(port)}` },
      installSignalHandlers: false,
    });

    sender.emit(validEvent(), MCP_SERVER_CALL);

    await expect(sender.flush()).resolves.toBeUndefined();
  });

  it('posts a successful request to <endpoint>/v1/logs with a JSON body', async () => {
    let receivedUrl: string | undefined;
    let receivedContentType: string | string[] | undefined;
    let receivedBody = '';

    const server = http.createServer((request, response) => {
      receivedUrl = request.url;
      receivedContentType = request.headers['content-type'];
      request.on('data', (chunk: Buffer) => {
        receivedBody += chunk.toString('utf8');
      });
      request.on('end', () => {
        response.statusCode = 200;
        response.end();
      });
    });
    const port = await listenOnEphemeralPort(server);

    const sender = createOtlpSender({
      serviceName: 'test-service',
      env: { OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${String(port)}` },
      installSignalHandlers: false,
    });

    sender.emit(validEvent(), MCP_SERVER_CALL);
    await sender.flush();

    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });

    expect(receivedUrl).toBe('/v1/logs');
    expect(receivedContentType).toBe('application/json');

    let parseError: unknown = null;
    try {
      JSON.parse(receivedBody);
    } catch (error) {
      parseError = error;
    }
    expect(parseError).toBeNull();
  });
});

describe('createOtlpSender, failure then silence', () => {
  it('writes exactly one line to stderr across three failing flush cycles', async () => {
    vi.resetModules();
    const freshModule = await import('../src/events/otlp.js');

    const fetchImpl = vi.fn(() => Promise.reject(new Error('boom')));
    const lines: string[] = [];
    const stderr = { write: (line: string) => lines.push(line) };

    const sender = freshModule.createOtlpSender({
      serviceName: 'test-service',
      env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318' },
      fetchImpl,
      stderr,
      installSignalHandlers: false,
    });

    for (let i = 0; i < 3; i += 1) {
      sender.emit(validEvent(), MCP_SERVER_CALL);
      await sender.flush();
    }

    expect(lines).toHaveLength(1);
  });

  it('counts a response status outside 200 to 299 as a failure, and still resolves flush', async () => {
    vi.resetModules();
    const freshModule = await import('../src/events/otlp.js');

    const fetchImpl = vi.fn(() => Promise.resolve(new Response('error', { status: 500 })));
    const lines: string[] = [];
    const stderr = { write: (line: string) => lines.push(line) };

    const sender = freshModule.createOtlpSender({
      serviceName: 'test-service',
      env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318' },
      fetchImpl,
      stderr,
      installSignalHandlers: false,
    });

    sender.emit(validEvent(), MCP_SERVER_CALL);
    await expect(sender.flush()).resolves.toBeUndefined();

    expect(lines).toHaveLength(1);
  });
});

describe('createOtlpSender, invalid Event', () => {
  it('does not throw on an Event that fails schema validation, and makes no request', async () => {
    const fetchImpl = vi.fn();
    const sender = createOtlpSender({
      serviceName: 'test-service',
      env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318' },
      fetchImpl,
      installSignalHandlers: false,
    });

    expect(() => {
      sender.emit(invalidEvent(), RUNNER_RUN_START);
    }).not.toThrow();

    await sender.flush();

    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('createOtlpSender, scheduled delay batching', () => {
  it('batches two emit calls inside one scheduled-delay window into one export call carrying two records', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn<typeof fetch>(() =>
        Promise.resolve(new Response(null, { status: 200 })),
      );
      const sender = createOtlpSender({
        serviceName: 'test-service',
        env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318' },
        fetchImpl,
        installSignalHandlers: false,
        scheduledDelayMs: 1000,
      });

      sender.emit(validEvent(), MCP_SERVER_CALL);
      sender.emit(validEvent(), MCP_SERVER_CALL);

      await vi.advanceTimersByTimeAsync(1000);

      expect(fetchImpl).toHaveBeenCalledTimes(1);

      const [call] = fetchImpl.mock.calls;
      if (call === undefined) {
        throw new Error('expected one fetch call');
      }
      const [, init] = call;
      if (init === undefined || typeof init.body !== 'string') {
        throw new Error('expected a request body string');
      }
      const matches = init.body.match(/"eventName":"mcp_server\.call"/g);
      expect(matches).not.toBeNull();
      expect(matches?.length).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('createOtlpSender, installSignalHandlers false', () => {
  it('adds no SIGINT listener', () => {
    const before = process.listenerCount('SIGINT');

    createOtlpSender({
      serviceName: 'test-service',
      env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318' },
      fetchImpl: vi.fn(),
      installSignalHandlers: false,
    });

    const after = process.listenerCount('SIGINT');
    expect(after).toBe(before);
  });
});
