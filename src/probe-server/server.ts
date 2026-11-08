import { z } from 'zod';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import type { OtlpSender } from '../events/otlp.js';
import { MCP_SERVER_CALL } from '../events/event-names.js';
import { sha256Hex } from '../hash.js';
import { FALLBACK_ENTRY, FALLBACK_TARGET, route } from './catalogue.js';
import { createUlidFactory } from './ulid.js';
import {
  buildCallEvent,
  MCP_SERVER_ERROR_MESSAGES,
  type CallFacts,
  type McpServerErrorType,
} from './event.js';

export const PROBE_TOOL_NAME = 'probe';
export const PROBE_SERVICE_NAME = 'probe-server';
export const PROBE_SERVICE_VERSION = '0.1.0';
export const INTERNAL_MS = 5;
export const MIN_UPSTREAM_MS = 50;
export const MAX_UPSTREAM_MS = 400;
export const MAX_REQUEST_LENGTH = 4096;

export interface ProbeServerOptions {
  sender: OtlpSender;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
  newCallId?: () => string;
  sessionId?: string;
  project?: string;
  serviceVersion?: string;
}

const RequestArgumentsSchema = z.object({
  request: z.string().min(1).max(MAX_REQUEST_LENGTH),
});

interface CachedOutcome {
  readonly status: 'ok' | 'error';
  readonly errorType?: McpServerErrorType;
  readonly target: string;
  readonly upstreamService: string;
  readonly routeConfidence: number;
  readonly upstreamStatus: number;
  readonly rawBytes: number;
  readonly text: string;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function clampDuration(value: number): number {
  return Math.max(0, Math.round(value));
}

function encodedByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * Uses the low-level `Server` class, which the SDK marks deprecated in
 * favour of `McpServer` "for the high-level API", while directing advanced
 * cases back to `Server`
 * (node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.d.ts:71).
 * This is such a case. The contract requires exactly one
 * `mcp_server.call` Event per `tools/call`, including a deliberately
 * invalid one. `McpServer.registerTool` validates the arguments against
 * its Zod input schema inside the SDK and rejects a malformed object
 * before the callback runs, so that call would emit no Event.
 * `Server.setRequestHandler` puts argument validation inside this handler,
 * so every `tools/call` produces one Event.
 */
// eslint-disable-next-line @typescript-eslint/no-deprecated
export function createProbeServer(options: ProbeServerOptions): { server: Server } {
  const sender = options.sender;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const newCallId = options.newCallId ?? createUlidFactory();
  const sessionId = options.sessionId ?? createUlidFactory()();
  const project = options.project ?? PROBE_SERVICE_NAME;
  const serviceVersion = options.serviceVersion ?? PROBE_SERVICE_VERSION;

  const cache = new Map<string, CachedOutcome>();

  // eslint-disable-next-line @typescript-eslint/no-deprecated
  const server = new Server(
    { name: PROBE_SERVICE_NAME, version: serviceVersion },
    { capabilities: { tools: {} } },
  );

  function emitAndRespond(facts: CallFacts, text: string, isError: boolean): CallToolResult {
    // ORDER MATTERS: build the CallToolResult first, then the Event, then
    // emit, then return. The event records exactly what is being returned.
    const result: CallToolResult = isError
      ? { content: [{ type: 'text', text }], isError: true }
      : { content: [{ type: 'text', text }] };

    const event = buildCallEvent(facts);
    // `emit` is synchronous and fire-and-forget (it only queues the Event
    // for the batch processor), so calling it here never delays the
    // response above.
    sender.emit(event, MCP_SERVER_CALL);
    // No `mcp_server.start` event is emitted here: `EventSchema` has no
    // `mcp_server_start` Kind, so `sender.emit` would reject it, and the
    // contract makes that event's absence a SHOULD warning, never a MUST
    // failure.

    return result;
  }

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [
      {
        name: PROBE_TOOL_NAME,
        description:
          'Routes a text request to a fixed catalogue target and returns a canned result.',
        inputSchema: {
          type: 'object',
          properties: { request: { type: 'string' } },
          required: ['request'],
          additionalProperties: false,
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const t0 = now();
    await sleep(INTERNAL_MS);
    const t1 = now();
    const internalMs = clampDuration(t1 - t0);

    const rawArguments = request.params.arguments ?? {};
    const requestBytes = encodedByteLength(JSON.stringify(rawArguments));

    const clientInfo = server.getClientVersion();
    const clientName = clientInfo?.name ?? 'unknown';
    const clientVersion = clientInfo?.version ?? '0.0.0';

    const sharedFacts = {
      callId: newCallId(),
      toolName: PROBE_TOOL_NAME,
      requestId: String(extra.requestId),
      sessionId,
      clientName,
      clientVersion,
      serviceVersion,
      project,
      requestBytes,
    };

    const parsed = RequestArgumentsSchema.safeParse(rawArguments);

    if (!parsed.success) {
      const text = MCP_SERVER_ERROR_MESSAGES.bad_request;
      const facts: CallFacts = {
        ...sharedFacts,
        target: FALLBACK_TARGET,
        upstreamService: FALLBACK_ENTRY.service,
        routeConfidence: 0,
        cache: 'bypass',
        status: 'error',
        errorType: 'bad_request',
        totalMs: internalMs,
        internalMs,
        upstreamMs: 0,
        upstreamAttempts: 0,
        upstreamStatus: 0,
        rawBytes: 0,
        returnedBytes: encodedByteLength(text),
      };
      return emitAndRespond(facts, text, true);
    }

    const requestText = parsed.data.request;
    const cacheKey = sha256Hex(requestText);
    const cached = cache.get(cacheKey);

    if (cached !== undefined) {
      const facts: CallFacts = {
        ...sharedFacts,
        target: cached.target,
        upstreamService: cached.upstreamService,
        routeConfidence: cached.routeConfidence,
        cache: 'hit',
        status: cached.status,
        ...(cached.errorType !== undefined ? { errorType: cached.errorType } : {}),
        totalMs: internalMs,
        internalMs,
        upstreamMs: 0,
        upstreamAttempts: 0,
        upstreamStatus: cached.upstreamStatus,
        rawBytes: cached.rawBytes,
        returnedBytes: encodedByteLength(cached.text),
      };
      return emitAndRespond(facts, cached.text, cached.status === 'error');
    }

    const choice = route(requestText);

    if (choice.matched) {
      const delay =
        MIN_UPSTREAM_MS + Math.floor(random() * (MAX_UPSTREAM_MS - MIN_UPSTREAM_MS + 1));
      await sleep(delay);
      const t2 = now();
      const upstreamMs = clampDuration(t2 - t1);
      const totalMs = clampDuration(t2 - t0);

      const text = choice.entry.result;

      cache.set(cacheKey, {
        status: 'ok',
        target: choice.entry.target,
        upstreamService: choice.entry.service,
        routeConfidence: choice.confidence,
        upstreamStatus: choice.entry.upstreamStatus,
        rawBytes: choice.entry.rawBytes,
        text,
      });

      const facts: CallFacts = {
        ...sharedFacts,
        target: choice.entry.target,
        upstreamService: choice.entry.service,
        routeConfidence: choice.confidence,
        cache: 'miss',
        status: 'ok',
        totalMs,
        internalMs,
        upstreamMs,
        upstreamAttempts: 1,
        upstreamStatus: choice.entry.upstreamStatus,
        rawBytes: choice.entry.rawBytes,
        returnedBytes: encodedByteLength(text),
      };
      return emitAndRespond(facts, text, false);
    }

    const text = MCP_SERVER_ERROR_MESSAGES.no_target;

    cache.set(cacheKey, {
      status: 'error',
      errorType: 'no_target',
      target: FALLBACK_TARGET,
      upstreamService: choice.entry.service,
      routeConfidence: 0,
      upstreamStatus: 0,
      rawBytes: 0,
      text,
    });

    const facts: CallFacts = {
      ...sharedFacts,
      target: FALLBACK_TARGET,
      upstreamService: choice.entry.service,
      routeConfidence: 0,
      cache: 'miss',
      status: 'error',
      errorType: 'no_target',
      totalMs: internalMs,
      internalMs,
      upstreamMs: 0,
      upstreamAttempts: 0,
      upstreamStatus: 0,
      rawBytes: 0,
      returnedBytes: encodedByteLength(text),
    };
    return emitAndRespond(facts, text, true);
  });

  return { server };
}
