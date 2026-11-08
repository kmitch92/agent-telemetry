import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createOtlpSender, type OtlpSender } from '../src/events/otlp.js';
import {
  OtlpLogsPayloadSchema,
  fromAnyValue,
  type OtlpAttribute,
} from '../src/events/otlp-payload.js';
import { MCP_SERVER_CALL } from '../src/events/event-names.js';
import { CATALOGUE, FALLBACK_TARGET, route } from '../src/probe-server/catalogue.js';
import { createUlidFactory } from '../src/probe-server/ulid.js';
import { createProbeServer, PROBE_TOOL_NAME } from '../src/probe-server/server.js';

const MARKER = 'zzqq-probe-marker-7';

function expectDefined<T>(value: T | undefined, message: string): T {
  if (value === undefined) {
    throw new Error(message);
  }
  return value;
}

// ---------------------------------------------------------------------------
// JSON-RPC driver over real stdio framing (no subprocess)
// ---------------------------------------------------------------------------

const JsonRpcSuccessSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.number(),
  result: z.unknown(),
});

const JsonRpcFailureSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.number(),
  error: z.object({ code: z.number(), message: z.string() }),
});

interface PendingEntry {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

interface JsonRpcDriver {
  sendRequest: (method: string, params: unknown) => Promise<unknown>;
  sendNotification: (method: string, params: unknown) => void;
}

function createJsonRpcDriver(
  serverToClient: PassThrough,
  clientToServer: PassThrough,
): JsonRpcDriver {
  const pending = new Map<number, PendingEntry>();
  let buffer = '';
  let nextId = 1;

  serverToClient.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf('\n');

      if (line.trim() === '') {
        continue;
      }

      const parsed: unknown = JSON.parse(line);

      const success = JsonRpcSuccessSchema.safeParse(parsed);
      if (success.success) {
        const entry = pending.get(success.data.id);
        if (entry !== undefined) {
          pending.delete(success.data.id);
          entry.resolve(success.data.result);
        }
        continue;
      }

      const failure = JsonRpcFailureSchema.safeParse(parsed);
      if (failure.success) {
        const entry = pending.get(failure.data.id);
        if (entry !== undefined) {
          pending.delete(failure.data.id);
          entry.reject(new Error(failure.data.error.message));
        }
      }
    }
  });

  function sendRequest(method: string, params: unknown): Promise<unknown> {
    const id = nextId;
    nextId += 1;
    const promise = new Promise<unknown>((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });
    clientToServer.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return promise;
  }

  function sendNotification(method: string, params: unknown): void {
    clientToServer.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  return { sendRequest, sendNotification };
}

// ---------------------------------------------------------------------------
// Probe server test bed
// ---------------------------------------------------------------------------

interface TestBed {
  sendRequest: (method: string, params: unknown) => Promise<unknown>;
  sendNotification: (method: string, params: unknown) => void;
  bodies: string[];
  warnings: string[];
  flush: () => Promise<void>;
}

async function createTestBed(
  senderFactory: typeof createOtlpSender = createOtlpSender,
): Promise<TestBed> {
  const bodies: string[] = [];
  const warnings: string[] = [];

  const fetchImpl = ((_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = init?.body;
    if (typeof body !== 'string') {
      throw new Error('expected the OTLP sender to post a string request body');
    }
    bodies.push(body);
    return Promise.resolve(new Response(null, { status: 200 }));
  }) as typeof fetch;

  const sender: OtlpSender = senderFactory({
    serviceName: 'probe-server',
    env: {
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
      OTEL_RESOURCE_ATTRIBUTES: 'run_id=test-run',
    },
    fetchImpl,
    stderr: {
      write: (line: string) => {
        warnings.push(line);
      },
    },
    installSignalHandlers: false,
    scheduledDelayMs: 0,
  });

  const clientToServer = new PassThrough();
  const serverToClient = new PassThrough();

  let clock = 1_000_000;
  const sleep = (ms: number): Promise<void> => {
    clock += ms;
    return Promise.resolve();
  };
  const now = (): number => clock;
  const random = (): number => 0.5;

  let callCounter = 0;
  const newCallId = (): string => `01HZPROBECALL${String(++callCounter).padStart(13, '0')}`;

  const { server } = createProbeServer({ sender, sleep, now, random, newCallId });

  await server.connect(new StdioServerTransport(clientToServer, serverToClient));

  const driver = createJsonRpcDriver(serverToClient, clientToServer);

  await driver.sendRequest('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'probe-test-client', version: '9.9.9' },
  });
  driver.sendNotification('notifications/initialized', {});

  return {
    sendRequest: driver.sendRequest,
    sendNotification: driver.sendNotification,
    bodies,
    warnings,
    flush: () => sender.flush(),
  };
}

interface CapturedEntry {
  resourceAttributes: Map<string, string | number | boolean>;
  recordAttributes: Map<string, string | number | boolean>;
  eventName: string;
}

function readAttributes(
  attributes: readonly OtlpAttribute[],
): Map<string, string | number | boolean> {
  const map = new Map<string, string | number | boolean>();
  for (const attribute of attributes) {
    const value = fromAnyValue(attribute.value);
    if (value !== undefined) {
      map.set(attribute.key, value);
    }
  }
  return map;
}

function parseCapturedEntries(bodies: readonly string[]): CapturedEntry[] {
  const entries: CapturedEntry[] = [];
  for (const body of bodies) {
    const payload = OtlpLogsPayloadSchema.parse(JSON.parse(body));
    for (const resourceLog of payload.resourceLogs) {
      const resourceAttributes = readAttributes(resourceLog.resource.attributes);
      for (const scopeLog of resourceLog.scopeLogs) {
        for (const logRecord of scopeLog.logRecords) {
          entries.push({
            resourceAttributes,
            recordAttributes: readAttributes(logRecord.attributes),
            eventName: logRecord.eventName,
          });
        }
      }
    }
  }
  return entries;
}

async function callProbe(bed: TestBed, request: unknown): Promise<unknown> {
  const argumentsValue: Record<string, unknown> = request === undefined ? {} : { request };
  return bed.sendRequest('tools/call', {
    name: PROBE_TOOL_NAME,
    arguments: argumentsValue,
  });
}

async function callAndCapture(
  bed: TestBed,
  request: unknown,
): Promise<{
  result: unknown;
  entry: CapturedEntry;
}> {
  const result = await callProbe(bed, request);
  await bed.flush();
  const entries = parseCapturedEntries(bed.bodies);
  const entry = expectDefined(entries[entries.length - 1], 'expected a captured telemetry entry');
  return { result, entry };
}

const TextContentBlockSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
});

const CallToolResultSchema = z.object({
  content: z.array(TextContentBlockSchema),
  isError: z.boolean().optional(),
});

const ToolDefinitionSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  inputSchema: z.looseObject({
    type: z.string(),
    required: z.array(z.string()).optional(),
  }),
});

const ToolsListResultSchema = z.object({
  tools: z.array(ToolDefinitionSchema),
});

// ---------------------------------------------------------------------------
// 1. tools/list
// ---------------------------------------------------------------------------

describe('probe server, tools/list', () => {
  it('returns exactly one tool, named probe, requiring the request field', async () => {
    const bed = await createTestBed();
    const rawResult = await bed.sendRequest('tools/list', {});
    const result = ToolsListResultSchema.parse(rawResult);

    expect(result.tools).toHaveLength(1);
    const [tool] = result.tools;
    const definedTool = expectDefined(tool, 'expected exactly one tool');
    expect(definedTool.name).toBe(PROBE_TOOL_NAME);
    expect(definedTool.inputSchema.type).toBe('object');
    expect(definedTool.inputSchema.required).toEqual(['request']);
  });
});

// ---------------------------------------------------------------------------
// 2 & 3. matched request, first time then cache hit
// ---------------------------------------------------------------------------

describe('probe server, a matched request', () => {
  it('reports status ok, cache miss, and the matched upstream timing on the first call', async () => {
    const bed = await createTestBed();
    const [billingEntry] = CATALOGUE;
    const entryUnderTest = expectDefined(billingEntry, 'expected a billing catalogue entry');

    const { result, entry } = await callAndCapture(bed, `look up invoice 4471 ${MARKER}`);

    const callToolResult = CallToolResultSchema.parse(result);
    expect(callToolResult.isError).not.toBe(true);
    const [block] = callToolResult.content;
    const definedBlock = expectDefined(block, 'expected one content block');
    expect(definedBlock.text).toBe(entryUnderTest.result);

    expect(entry.recordAttributes.get('mcp_server.status')).toBe('ok');
    expect(entry.recordAttributes.get('mcp_server.target')).toBe('billing.lookup_invoice');
    expect(entry.recordAttributes.get('mcp_server.upstream.service')).toBe('billing');
    expect(entry.recordAttributes.get('mcp_server.cache')).toBe('miss');
    expect(entry.recordAttributes.get('mcp_server.upstream_ms')).toBe(225);
    expect(entry.recordAttributes.get('mcp_server.total_ms')).toBe(230);
    expect(entry.recordAttributes.get('mcp_server.internal_ms')).toBe(5);
    expect(entry.recordAttributes.get('mcp_server.upstream.attempts')).toBe(1);
    expect(entry.recordAttributes.get('mcp_server.upstream.status')).toBe(200);
    expect(entry.recordAttributes.has('mcp_server.error.type')).toBe(false);
  });

  it('serves the identical request from cache on a repeat, cheaply (acceptance criterion 2)', async () => {
    const bed = await createTestBed();
    const [billingEntry] = CATALOGUE;
    const entryUnderTest = expectDefined(billingEntry, 'expected a billing catalogue entry');
    const requestText = `look up invoice 4471 ${MARKER}`;

    const first = await callAndCapture(bed, requestText);
    const firstResult = CallToolResultSchema.parse(first.result);
    const [firstBlock] = firstResult.content;
    const definedFirstBlock = expectDefined(firstBlock, 'expected one content block');

    const second = await callAndCapture(bed, requestText);
    const secondResult = CallToolResultSchema.parse(second.result);
    const [secondBlock] = secondResult.content;
    const definedSecondBlock = expectDefined(secondBlock, 'expected one content block');

    expect(definedSecondBlock.text).toBe(definedFirstBlock.text);
    expect(definedSecondBlock.text).toBe(entryUnderTest.result);

    expect(second.entry.recordAttributes.get('mcp_server.cache')).toBe('hit');
    expect(second.entry.recordAttributes.get('mcp_server.upstream_ms')).toBe(0);
    expect(second.entry.recordAttributes.get('mcp_server.upstream.attempts')).toBe(0);
    expect(second.entry.recordAttributes.get('mcp_server.total_ms')).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// 4. bad_request errors (acceptance criterion 3)
// ---------------------------------------------------------------------------

describe('probe server, bad_request errors', () => {
  it('rejects a missing request field as bad_request', async () => {
    const bed = await createTestBed();
    const { result, entry } = await callAndCapture(bed, undefined);

    const callToolResult = CallToolResultSchema.parse(result);
    expect(callToolResult.isError).toBe(true);

    expect(entry.recordAttributes.get('mcp_server.status')).toBe('error');
    expect(entry.recordAttributes.get('mcp_server.error.type')).toBe('bad_request');
    expect(entry.recordAttributes.get('mcp_server.target')).toBe(FALLBACK_TARGET);
    expect(entry.recordAttributes.get('mcp_server.route.confidence')).toBe(0);
    expect(entry.recordAttributes.get('mcp_server.cache')).toBe('bypass');
  });

  it('rejects a non-string request field as bad_request', async () => {
    const bed = await createTestBed();
    const { result, entry } = await callAndCapture(bed, 42);

    const callToolResult = CallToolResultSchema.parse(result);
    expect(callToolResult.isError).toBe(true);

    expect(entry.recordAttributes.get('mcp_server.status')).toBe('error');
    expect(entry.recordAttributes.get('mcp_server.error.type')).toBe('bad_request');
    expect(entry.recordAttributes.get('mcp_server.target')).toBe(FALLBACK_TARGET);
    expect(entry.recordAttributes.get('mcp_server.route.confidence')).toBe(0);
    expect(entry.recordAttributes.get('mcp_server.cache')).toBe('bypass');
  });
});

// ---------------------------------------------------------------------------
// 5. no_target errors
// ---------------------------------------------------------------------------

describe('probe server, no_target errors', () => {
  it('reports no_target for an unroutable request, then a cache hit on repeat', async () => {
    const bed = await createTestBed();
    const requestText = `xyzzy ${MARKER}`;

    const first = await callAndCapture(bed, requestText);
    expect(first.entry.recordAttributes.get('mcp_server.status')).toBe('error');
    expect(first.entry.recordAttributes.get('mcp_server.error.type')).toBe('no_target');
    expect(first.entry.recordAttributes.get('mcp_server.target')).toBe(FALLBACK_TARGET);
    expect(first.entry.recordAttributes.get('mcp_server.route.confidence')).toBe(0);
    expect(first.entry.recordAttributes.get('mcp_server.cache')).toBe('miss');

    const second = await callAndCapture(bed, requestText);
    expect(second.entry.recordAttributes.get('mcp_server.error.type')).toBe('no_target');
    expect(second.entry.recordAttributes.get('mcp_server.cache')).toBe('hit');
  });
});

// ---------------------------------------------------------------------------
// 6. acceptance criterion 4: no leaked request text, no oversized attribute
// ---------------------------------------------------------------------------

describe('probe server, transport rules', () => {
  it('leaks no request text and keeps every attribute value at or under 2048 bytes', async () => {
    const bed = await createTestBed();

    const longRequest = MARKER.repeat(300).slice(0, 5000);
    expect(longRequest).toHaveLength(5000);

    await callAndCapture(bed, `look up invoice 9001 ${MARKER}`);
    await callAndCapture(bed, `track my shipment please ${MARKER}`);
    await callAndCapture(bed, `xyzzy nonsense ${MARKER}`);
    await callAndCapture(bed, longRequest);
    await callAndCapture(bed, undefined);

    const joined = bed.bodies.join('');
    expect(joined).not.toContain(MARKER);

    const entries = parseCapturedEntries(bed.bodies);
    const encoder = new TextEncoder();
    for (const entry of entries) {
      for (const value of entry.recordAttributes.values()) {
        expect(encoder.encode(String(value)).length).toBeLessThanOrEqual(2048);
      }
      for (const value of entry.resourceAttributes.values()) {
        expect(encoder.encode(String(value)).length).toBeLessThanOrEqual(2048);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 7. every MUST and SHOULD attribute present, with the correct JS type
// ---------------------------------------------------------------------------

type AttributeType = 'string' | 'number' | 'boolean';

const MUST_ATTRIBUTES: ReadonlyArray<readonly [string, AttributeType]> = [
  ['mcp_server.call_id', 'string'],
  ['mcp.method.name', 'string'],
  ['gen_ai.tool.name', 'string'],
  ['mcp_server.total_ms', 'number'],
  ['mcp_server.status', 'string'],
  ['mcp_server.upstream_ms', 'number'],
];

const SHOULD_ATTRIBUTES: ReadonlyArray<readonly [string, AttributeType]> = [
  ['mcp_server.internal_ms', 'number'],
  ['mcp_server.upstream.service', 'string'],
  ['mcp_server.upstream.status', 'number'],
  ['mcp_server.upstream.attempts', 'number'],
  ['mcp_server.target', 'string'],
  ['mcp_server.route.confidence', 'number'],
  ['mcp_server.cache', 'string'],
  ['mcp_server.raw_bytes', 'number'],
  ['mcp_server.returned_bytes', 'number'],
  ['mcp_server.request_bytes', 'number'],
  ['mcp_server.error.message', 'string'],
  ['mcp.tool.is_error', 'boolean'],
  ['mcp.request.id', 'string'],
  ['mcp.session.id', 'string'],
  ['mcp.client.name', 'string'],
  ['mcp.client.version', 'string'],
  ['service.version', 'string'],
];

describe('probe server, every MUST and SHOULD attribute', () => {
  it('carries every attribute from the contract tables, with the correct type', async () => {
    const bed = await createTestBed();
    const requestText = `look up invoice 7 ${MARKER}`;

    await callAndCapture(bed, requestText);
    await callAndCapture(bed, requestText);
    await callAndCapture(bed, undefined);
    await callAndCapture(bed, `xyzzy ${MARKER}`);

    const entries = parseCapturedEntries(bed.bodies);
    expect(entries.length).toBeGreaterThanOrEqual(4);

    for (const entry of entries) {
      for (const [key, type] of [...MUST_ATTRIBUTES, ...SHOULD_ATTRIBUTES]) {
        const value = entry.recordAttributes.get(key);
        expect(entry.recordAttributes.has(key)).toBe(true);
        expect(typeof value).toBe(type);
      }

      const status = entry.recordAttributes.get('mcp_server.status');
      const hasErrorType = entry.recordAttributes.has('mcp_server.error.type');
      expect(hasErrorType).toBe(status === 'error');
    }
  });
});

// ---------------------------------------------------------------------------
// 8. event name and call_id uniqueness
// ---------------------------------------------------------------------------

describe('probe server, event identity', () => {
  it('names every event mcp_server.call and gives each a distinct call_id', async () => {
    const bed = await createTestBed();
    const requestText = `look up invoice 12 ${MARKER}`;

    await callAndCapture(bed, requestText);
    await callAndCapture(bed, requestText);
    await callAndCapture(bed, `xyzzy ${MARKER}`);
    await callAndCapture(bed, undefined);
    await callAndCapture(bed, `track my shipment ${MARKER}`);

    const entries = parseCapturedEntries(bed.bodies);
    expect(entries.length).toBeGreaterThanOrEqual(5);

    const callIds: string[] = [];
    for (const entry of entries) {
      expect(entry.eventName).toBe(MCP_SERVER_CALL);
      expect(entry.recordAttributes.get('event.name')).toBe(MCP_SERVER_CALL);
      const callId = entry.recordAttributes.get('mcp_server.call_id');
      if (typeof callId === 'string') {
        callIds.push(callId);
      }
    }

    expect(callIds).toHaveLength(entries.length);
    expect(new Set(callIds).size).toBe(entries.length);
  });
});

// ---------------------------------------------------------------------------
// 9. resource attributes
// ---------------------------------------------------------------------------

describe('probe server, resource attributes', () => {
  it('carries service.name probe-server and run_id test-run on every record group', async () => {
    const bed = await createTestBed();

    await callAndCapture(bed, `look up invoice 44 ${MARKER}`);
    await callAndCapture(bed, `xyzzy ${MARKER}`);

    const entries = parseCapturedEntries(bed.bodies);
    expect(entries.length).toBeGreaterThanOrEqual(2);

    for (const entry of entries) {
      expect(entry.resourceAttributes.get('service.name')).toBe('probe-server');
      expect(entry.resourceAttributes.get('run_id')).toBe('test-run');
    }
  });
});

// ---------------------------------------------------------------------------
// 10. no schema-validation warnings
// ---------------------------------------------------------------------------

describe('probe server, EventSchema conformance', () => {
  it('writes zero lines to stderr, proving every emitted Event passed EventSchema', async () => {
    vi.resetModules();
    const freshOtlpModule = await import('../src/events/otlp.js');
    const bed = await createTestBed(freshOtlpModule.createOtlpSender);

    const requestText = `look up invoice 99 ${MARKER}`;
    await callAndCapture(bed, requestText);
    await callAndCapture(bed, requestText);
    await callAndCapture(bed, undefined);
    await callAndCapture(bed, `xyzzy ${MARKER}`);

    expect(bed.warnings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 11. pure unit tests for route
// ---------------------------------------------------------------------------

describe('route', () => {
  const realEntries = CATALOGUE.slice(0, 6);

  it.each(
    realEntries.map((entry) => {
      const [firstKeyword] = entry.keywords;
      return [entry.target, expectDefined(firstKeyword, 'expected at least one keyword')] as const;
    }),
  )('routes a request containing a keyword to %s', (target, keyword) => {
    const choice = route(`please handle this ${keyword} request`);
    expect(choice.entry.target).toBe(target);
    expect(choice.matched).toBe(true);
  });

  it('routes an unmatched request to the fallback target with zero confidence', () => {
    const choice = route('xyzzy nonsense text');
    expect(choice.matched).toBe(false);
    expect(choice.entry.target).toBe(FALLBACK_TARGET);
    expect(choice.confidence).toBe(0);
  });

  it('keeps confidence inside the 0 to 1 range', () => {
    const choice = route('invoice billing charge invoice billing charge');
    expect(choice.confidence).toBeGreaterThanOrEqual(0);
    expect(choice.confidence).toBeLessThanOrEqual(1);
  });

  it('breaks a tie between two equally-matched entries by catalogue order', () => {
    const [billingEntry] = CATALOGUE;
    const definedBillingEntry = expectDefined(billingEntry, 'expected a billing catalogue entry');
    const choice = route('invoice order');
    expect(choice.entry.target).toBe(definedBillingEntry.target);
  });
});

// ---------------------------------------------------------------------------
// 12. pure unit tests for createUlidFactory
// ---------------------------------------------------------------------------

describe('createUlidFactory', () => {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

  it('returns 26 characters, all drawn from the Crockford base32 alphabet', () => {
    const createUlid = createUlidFactory();
    const id = createUlid();

    expect(id).toHaveLength(26);
    expect(id.split('').every((character) => alphabet.includes(character))).toBe(true);
  });

  it('produces strictly increasing identifiers for a fixed timestamp', () => {
    const fixedNow = (): number => 1_700_000_000_000;
    const zeroRandomBytes = (byteCount: number): Uint8Array => new Uint8Array(byteCount);
    const createUlid = createUlidFactory(fixedNow, zeroRandomBytes);

    const first = createUlid();
    const second = createUlid();
    const third = createUlid();

    expect(first < second).toBe(true);
    expect(second < third).toBe(true);
  });
});
