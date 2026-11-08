/**
 * The MUST and SHOULD attribute tables of the MCP (Model Context Protocol)
 * server event contract, as data. Every row here is derived from
 * `docs/mcp-server-events.md:30-66`. This
 * module holds no check logic, only the facts a check reads.
 */

export const PRIMARY_EVENT_NAME = 'mcp_server.call';
export const SECONDARY_START_EVENT_NAME = 'mcp_server.start';
export const EXPECTED_CALL_COUNT = 13;
export const MAX_ATTRIBUTE_VALUE_BYTES = 2048;

export const STATUS_CLOSED_SET: readonly string[] = ['ok', 'error'];

export const ERROR_TYPE_CLOSED_SET: readonly string[] = [
  'no_target',
  'upstream_http',
  'upstream_timeout',
  'upstream_connect',
  'bad_request',
  'internal',
];

export type AttributeValueForm = 'stringValue' | 'intValue' | 'doubleValue' | 'boolValue';

export interface AttributeRule {
  key: string;
  form: AttributeValueForm;
  closedSet?: readonly string[];
}

/**
 * `mcp_server.error.type` is deliberately NOT in `MUST_ATTRIBUTES`: it is
 * conditional on the status value (required only when `mcp_server.status`
 * is `error`), so a separate check handles it instead of this fixed table.
 * `mcp_server.upstream_ms` is deliberately NOT in `MUST_ATTRIBUTES`: no
 * observer outside the server can tell whether the server made an upstream
 * request, so it can only be a SHOULD row here.
 */
export const MUST_ATTRIBUTES: readonly AttributeRule[] = [
  { key: 'mcp_server.call_id', form: 'stringValue' },
  { key: 'mcp.method.name', form: 'stringValue' },
  { key: 'gen_ai.tool.name', form: 'stringValue' },
  { key: 'mcp_server.total_ms', form: 'intValue' },
  { key: 'mcp_server.status', form: 'stringValue', closedSet: STATUS_CLOSED_SET },
];

export const SHOULD_ATTRIBUTES: readonly AttributeRule[] = [
  { key: 'mcp_server.internal_ms', form: 'intValue' },
  { key: 'mcp_server.upstream_ms', form: 'intValue' },
  { key: 'mcp_server.upstream.service', form: 'stringValue' },
  { key: 'mcp_server.upstream.status', form: 'intValue' },
  { key: 'mcp_server.upstream.attempts', form: 'intValue' },
  { key: 'mcp_server.target', form: 'stringValue' },
  { key: 'mcp_server.route.confidence', form: 'doubleValue' },
  { key: 'mcp_server.cache', form: 'stringValue', closedSet: ['hit', 'miss', 'bypass', 'stale'] },
  { key: 'mcp_server.raw_bytes', form: 'intValue' },
  { key: 'mcp_server.returned_bytes', form: 'intValue' },
  { key: 'mcp_server.request_bytes', form: 'intValue' },
  { key: 'mcp_server.error.message', form: 'stringValue' },
  { key: 'mcp.tool.is_error', form: 'boolValue' },
  { key: 'mcp.request.id', form: 'stringValue' },
  { key: 'mcp.session.id', form: 'stringValue' },
  { key: 'mcp.client.name', form: 'stringValue' },
  { key: 'mcp.client.version', form: 'stringValue' },
  { key: 'service.version', form: 'stringValue' },
];
