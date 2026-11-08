/**
 * Builds the fixed conformance-check request script: one `initialize`
 * request, then `tools/list`, then six distinct `tools/call` requests, the
 * same six again, then one deliberately invalid `tools/call` request. The
 * conformance procedure at
 * `docs/mcp-server-events.md:145-150` does
 * not list `tools/list` among the driven requests, but this checker is
 * server-agnostic: it cannot otherwise learn a tool name to call. Sending
 * `tools/list` stays harmless to the thirteen-event count, because
 * `tools/list` is not a `tools/call`, so exactly thirteen `mcp_server.call`
 * events are still due.
 */

import type { JsonSchemaNode, ToolDescriptor } from '../schema/conform.js';

export type { JsonSchemaNode, ToolDescriptor } from '../schema/conform.js';

export interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: number;
  method: string;
  params?: unknown;
}

export interface ConformScript {
  messages: readonly JsonRpcMessage[];
  callMessages: readonly JsonRpcMessage[];
  nonces: readonly string[];
  invalidRequestId: number;
  toolName: string;
}

export const PROTOCOL_VERSION = '2025-06-18';
export const CLIENT_NAME = 'mcp-conform';

const FIRST_CALL_ID = 3;
const SECOND_SET_CALL_ID = 9;
const INVALID_REQUEST_ID = 15;
const CALLS_PER_SET = 6;

export function buildHandshakeMessages(): readonly JsonRpcMessage[] {
  return [
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: CLIENT_NAME, version: '0.1.0' },
      },
    },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  ];
}

function synthesiseValue(propertySchema: JsonSchemaNode | undefined, nonce: string): unknown {
  if (propertySchema === undefined) {
    return `conform request ${nonce}`;
  }

  switch (propertySchema.type) {
    case 'string':
      return `conform request ${nonce}`;
    case 'integer':
    case 'number':
      return 1;
    case 'boolean':
      return true;
    case 'array':
      return [];
    case 'object':
      return synthesiseArguments(propertySchema, nonce);
    default:
      return `conform request ${nonce}`;
  }
}

export function synthesiseArguments(
  schema: JsonSchemaNode | undefined,
  nonce: string,
): Record<string, unknown> {
  if (
    schema === undefined ||
    schema.required === undefined ||
    schema.required.length === 0 ||
    schema.properties === undefined
  ) {
    return {};
  }

  const properties = schema.properties;
  const result: Record<string, unknown> = {};
  for (const key of schema.required) {
    result[key] = synthesiseValue(properties[key], nonce);
  }

  return result;
}

/**
 * Replaces the first key whose value is a string with the number `0`,
 * keeping every other key and the original key order. When no key holds a
 * string, adds a `conformInvalid` key instead, so the request still differs
 * from a valid one.
 */
function buildInvalidArguments(argumentObject: Record<string, unknown>): Record<string, unknown> {
  const entries = Object.entries(argumentObject);
  const firstStringIndex = entries.findIndex(([, value]) => typeof value === 'string');

  if (firstStringIndex === -1) {
    return { ...argumentObject, conformInvalid: 0 };
  }

  const replacedEntries = entries.map(([key, value], index): [string, unknown] =>
    index === firstStringIndex ? [key, 0] : [key, value],
  );

  return Object.fromEntries(replacedEntries);
}

function buildArgumentObjects(
  inputSchema: JsonSchemaNode | undefined,
  nextNonce: () => string,
): { argumentObjects: readonly Record<string, unknown>[]; nonces: readonly string[] } {
  const nonces: string[] = [];
  const argumentObjects: Record<string, unknown>[] = [];

  for (let i = 0; i < CALLS_PER_SET; i += 1) {
    const nonce = nextNonce();
    nonces.push(nonce);
    argumentObjects.push(synthesiseArguments(inputSchema, nonce));
  }

  return { argumentObjects, nonces };
}

function buildCallMessage(
  id: number,
  toolName: string,
  argumentsObject: Record<string, unknown>,
): JsonRpcMessage {
  return {
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name: toolName, arguments: argumentsObject },
  };
}

export function buildConformScript(input: {
  tools: readonly ToolDescriptor[];
  nextNonce: () => string;
}): ConformScript {
  const { tools, nextNonce } = input;
  const firstTool = tools[0];
  if (firstTool === undefined) {
    throw new Error('buildConformScript: the server listed no tool');
  }

  const toolName = firstTool.name;
  const { argumentObjects, nonces } = buildArgumentObjects(firstTool.inputSchema, nextNonce);

  const firstSetMessages: JsonRpcMessage[] = [];
  for (let i = 0; i < CALLS_PER_SET; i += 1) {
    firstSetMessages.push(buildCallMessage(FIRST_CALL_ID + i, toolName, argumentObjects[i] ?? {}));
  }

  const secondSetMessages: JsonRpcMessage[] = [];
  for (let i = 0; i < CALLS_PER_SET; i += 1) {
    secondSetMessages.push(
      buildCallMessage(SECOND_SET_CALL_ID + i, toolName, argumentObjects[i] ?? {}),
    );
  }

  const invalidMessage = buildCallMessage(
    INVALID_REQUEST_ID,
    toolName,
    buildInvalidArguments(argumentObjects[0] ?? {}),
  );

  const callMessages = [...firstSetMessages, ...secondSetMessages, invalidMessage];

  return {
    messages: [...buildHandshakeMessages(), ...callMessages],
    callMessages,
    nonces,
    invalidRequestId: INVALID_REQUEST_ID,
    toolName,
  };
}
