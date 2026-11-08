import type { McpServerCallEvent } from '../schema/index.js';

/**
 * Pure `mcp_server.call` Event builder. No import from `node:*`, no file or
 * network access: shaping the Event object only.
 */

export type McpServerErrorType = NonNullable<McpServerCallEvent['mcp_server.error.type']>;

/**
 * One short, fixed sentence per closed-set error type, each under 256
 * characters and carrying no request or response text, per the contract's
 * `mcp_server.error.message` rule.
 */
export const MCP_SERVER_ERROR_MESSAGES: Record<McpServerErrorType, string> = {
  bad_request: 'the request argument is missing, empty, not a string, or over 4096 characters',
  no_target: 'no catalogue target matched the request',
  upstream_http: 'the upstream service returned a failure status',
  upstream_timeout: 'the upstream service did not answer inside the timeout',
  upstream_connect: 'the upstream service refused the connection',
  internal: 'the server failed while handling the call',
};

/**
 * `CallFacts` deliberately carries no request text. That is the structural
 * guarantee behind the contract rule "no attribute carries request text":
 * this pure builder cannot emit what it never receives.
 */
export interface CallFacts {
  readonly callId: string;
  readonly toolName: string;
  readonly target: string;
  readonly upstreamService: string;
  readonly routeConfidence: number;
  readonly cache: 'hit' | 'miss' | 'bypass' | 'stale';
  readonly status: 'ok' | 'error';
  readonly errorType?: McpServerErrorType;
  readonly totalMs: number;
  readonly internalMs: number;
  readonly upstreamMs: number;
  readonly upstreamStatus: number;
  readonly upstreamAttempts: number;
  readonly rawBytes: number;
  readonly returnedBytes: number;
  readonly requestBytes: number;
  readonly requestId: string;
  readonly sessionId: string;
  readonly clientName: string;
  readonly clientVersion: string;
  readonly serviceVersion: string;
  readonly project: string;
}

/**
 * Builds one `mcp_server.call` Event from `facts`. `mcp_server.error.type`
 * is present only when `facts.status === 'error'`; `exactOptionalProperty
 * Types` means the key is omitted rather than set to `undefined` when it
 * does not apply.
 */
export function buildCallEvent(facts: CallFacts): McpServerCallEvent {
  const isError = facts.status === 'error';
  const errorMessage =
    isError && facts.errorType !== undefined ? MCP_SERVER_ERROR_MESSAGES[facts.errorType] : '';

  const base = {
    kind: 'mcp_server_call' as const,
    agent: facts.clientName,
    session_id: facts.sessionId,
    project: facts.project,
    'mcp_server.call_id': facts.callId,
    'mcp.method.name': 'tools/call',
    'gen_ai.tool.name': facts.toolName,
    'mcp_server.total_ms': facts.totalMs,
    'mcp_server.status': facts.status,
    'mcp_server.error.message': errorMessage,
    'mcp_server.internal_ms': facts.internalMs,
    'mcp_server.upstream_ms': facts.upstreamMs,
    'mcp_server.upstream.status': facts.upstreamStatus,
    'mcp_server.upstream.attempts': facts.upstreamAttempts,
    'mcp_server.upstream.service': facts.upstreamService,
    'mcp_server.target': facts.target,
    'mcp_server.route.confidence': facts.routeConfidence,
    'mcp_server.cache': facts.cache,
    'mcp_server.raw_bytes': facts.rawBytes,
    'mcp_server.returned_bytes': facts.returnedBytes,
    'mcp_server.request_bytes': facts.requestBytes,
    'mcp.tool.is_error': isError,
    'mcp.request.id': facts.requestId,
    'mcp.session.id': facts.sessionId,
    'mcp.client.name': facts.clientName,
    'mcp.client.version': facts.clientVersion,
    'service.version': facts.serviceVersion,
  };

  if (isError && facts.errorType !== undefined) {
    return { ...base, 'mcp_server.error.type': facts.errorType };
  }

  return base;
}
