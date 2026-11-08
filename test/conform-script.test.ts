import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { JsonRpcMessage, JsonSchemaNode, ToolDescriptor } from '../src/conform/script.js';
import {
  CLIENT_NAME,
  PROTOCOL_VERSION,
  buildConformScript,
  buildHandshakeMessages,
  synthesiseArguments,
} from '../src/conform/script.js';

function expectDefined<T>(value: T | undefined, message: string): T {
  if (value === undefined) {
    throw new Error(message);
  }
  return value;
}

/** Narrows a `tools/call` message's `params` without a cast. */
const ToolCallParamsSchema = z.object({
  name: z.string(),
  arguments: z.record(z.string(), z.unknown()),
});

function createCountingNonceFactory(): () => string {
  let count = 0;
  return () => {
    count += 1;
    return `nonce-${String(count)}`;
  };
}

describe('constants', () => {
  it('fixes the protocol version and the client name', () => {
    expect(PROTOCOL_VERSION).toBe('2025-06-18');
    expect(CLIENT_NAME).toBe('mcp-conform');
  });
});

describe('buildHandshakeMessages', () => {
  it('returns the initialize request, the initialized notification, then tools/list', () => {
    const messages = buildHandshakeMessages();

    expect(messages).toEqual([
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
    ]);

    const notification = expectDefined(messages[1], 'expected the second handshake message');
    expect('id' in notification).toBe(false);
  });
});

describe('synthesiseArguments', () => {
  it('fills a single required string property', () => {
    const schema: JsonSchemaNode = {
      type: 'object',
      required: ['name'],
      properties: { name: { type: 'string' } },
    };

    expect(synthesiseArguments(schema, 'n1')).toEqual({ name: 'conform request n1' });
  });

  it('fills a required integer property and a required boolean property', () => {
    const schema: JsonSchemaNode = {
      type: 'object',
      required: ['count', 'flag'],
      properties: {
        count: { type: 'integer' },
        flag: { type: 'boolean' },
      },
    };

    expect(synthesiseArguments(schema, 'n2')).toEqual({ count: 1, flag: true });
  });

  it('recurses into a required object property with its own required string property', () => {
    const schema: JsonSchemaNode = {
      type: 'object',
      required: ['inner'],
      properties: {
        inner: {
          type: 'object',
          required: ['value'],
          properties: { value: { type: 'string' } },
        },
      },
    };

    expect(synthesiseArguments(schema, 'n3')).toEqual({ inner: { value: 'conform request n3' } });
  });

  it('returns {} when the schema has properties but no required list', () => {
    const schema: JsonSchemaNode = {
      type: 'object',
      properties: { name: { type: 'string' } },
    };

    expect(synthesiseArguments(schema, 'n4')).toEqual({});
  });

  it('returns {} when the schema is undefined', () => {
    expect(synthesiseArguments(undefined, 'n5')).toEqual({});
  });

  it('fills a required property with no definition in properties', () => {
    const schema: JsonSchemaNode = {
      type: 'object',
      required: ['missing'],
      properties: {},
    };

    expect(synthesiseArguments(schema, 'n6')).toEqual({ missing: 'conform request n6' });
  });
});

describe('buildConformScript', () => {
  const tool: ToolDescriptor = {
    name: 'lookup',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: { query: { type: 'string' } },
    },
  };

  it('throws when the server listed no tool', () => {
    expect(() =>
      buildConformScript({ tools: [], nextNonce: createCountingNonceFactory() }),
    ).toThrow();
  });

  it('builds 16 messages, 13 call messages and 6 nonces, with invalidRequestId 15', () => {
    const script = buildConformScript({ tools: [tool], nextNonce: createCountingNonceFactory() });

    expect(script.toolName).toBe('lookup');
    expect(script.messages.length).toBe(16);
    expect(script.callMessages.length).toBe(13);
    expect(script.nonces.length).toBe(6);
    expect(script.invalidRequestId).toBe(15);
    expect(script.callMessages.map((message) => message.id)).toEqual([
      3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
    ]);
  });

  it('calls nextNonce exactly six times, producing six distinct nonces', () => {
    const nextNonce = vi.fn(createCountingNonceFactory());
    const script = buildConformScript({ tools: [tool], nextNonce });

    expect(nextNonce).toHaveBeenCalledTimes(6);
    expect(new Set(script.nonces).size).toBe(6);
  });

  it('repeats the first six call messages byte-identically in the next six', () => {
    const script = buildConformScript({ tools: [tool], nextNonce: createCountingNonceFactory() });

    for (let i = 0; i < 6; i += 1) {
      const first = expectDefined(script.callMessages[i], `expected call message ${String(i)}`);
      const second = expectDefined(
        script.callMessages[6 + i],
        `expected call message ${String(6 + i)}`,
      );
      expect(JSON.stringify(second.params)).toBe(JSON.stringify(first.params));
    }
  });

  it('replaces the first required string property with 0 in the invalid request', () => {
    const multiPropertyTool: ToolDescriptor = {
      name: 'lookup',
      inputSchema: {
        type: 'object',
        required: ['count', 'label', 'flag'],
        properties: {
          count: { type: 'integer' },
          label: { type: 'string' },
          flag: { type: 'boolean' },
        },
      },
    };

    const nextNonce = createCountingNonceFactory();
    const nonces: string[] = [];
    const recordingNextNonce = (): string => {
      const nonce = nextNonce();
      nonces.push(nonce);
      return nonce;
    };

    const script = buildConformScript({
      tools: [multiPropertyTool],
      nextNonce: recordingNextNonce,
    });

    const firstNonce = expectDefined(nonces[0], 'expected at least one nonce');
    const argumentObject0 = synthesiseArguments(multiPropertyTool.inputSchema, firstNonce);

    const invalidMessage = expectDefined(
      script.callMessages.find((message) => message.id === script.invalidRequestId),
      'expected the invalid request message',
    );

    const params = ToolCallParamsSchema.parse(invalidMessage.params);
    expect(params.name).toBe('lookup');
    expect(params.arguments).toEqual({ ...argumentObject0, label: 0 });
  });

  it('falls back to a conformInvalid key when no property holds a string', () => {
    const numericOnlyTool: ToolDescriptor = {
      name: 'lookup',
      inputSchema: {
        type: 'object',
        required: ['count'],
        properties: { count: { type: 'integer' } },
      },
    };

    const script = buildConformScript({
      tools: [numericOnlyTool],
      nextNonce: createCountingNonceFactory(),
    });

    const invalidMessage = expectDefined(
      script.callMessages.find((message) => message.id === script.invalidRequestId),
      'expected the invalid request message',
    );

    const params = ToolCallParamsSchema.parse(invalidMessage.params);
    expect(params.arguments).toEqual({ count: 1, conformInvalid: 0 });
  });

  it('builds messages as the handshake followed by the call messages', () => {
    const script = buildConformScript({ tools: [tool], nextNonce: createCountingNonceFactory() });
    const expectedMessages: readonly JsonRpcMessage[] = [
      ...buildHandshakeMessages(),
      ...script.callMessages,
    ];

    expect(script.messages).toEqual(expectedMessages);
  });
});
