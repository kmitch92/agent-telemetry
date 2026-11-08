import { describe, expect, it } from 'vitest';
import {
  buildLogsPayload,
  buildRecordAttributes,
  buildResourceAttributes,
  parseResourceAttributes,
  toAnyValue,
} from '../src/events/otlp-payload.js';
import { MCP_SERVER_CALL } from '../src/events/event-names.js';
import type { McpServerCallEvent, RunStartEvent } from '../src/schema/index.js';

function mcpServerCallEvent(): McpServerCallEvent {
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

function runStartEvent(): RunStartEvent {
  return {
    agent: 'claude-code',
    session_id: 'session-1',
    project: 'agent-telemetry-abcd1234',
    kind: 'run_start',
    rep: 0,
  };
}

describe('buildLogsPayload, hand-written expected body', () => {
  it('builds the exact OTLP logs payload for one mcp_server_call Event', () => {
    const envAttributes = parseResourceAttributes('run_id=r1,task=hello');

    const payload = buildLogsPayload({
      serviceName: 'probe-server',
      scopeName: 'agent-telemetry',
      scopeVersion: '0.1.0',
      records: [
        {
          event: mcpServerCallEvent(),
          eventName: MCP_SERVER_CALL,
          timeUnixNano: '1700000000000000000',
        },
      ],
      envAttributes,
    });

    expect(payload).toEqual({
      resourceLogs: [
        {
          resource: {
            attributes: [
              { key: 'service.name', value: { stringValue: 'probe-server' } },
              { key: 'agent', value: { stringValue: 'claude-code' } },
              { key: 'session_id', value: { stringValue: 'session-1' } },
              { key: 'project', value: { stringValue: 'agent-telemetry-abcd1234' } },
              { key: 'run_id', value: { stringValue: 'r1' } },
              { key: 'task', value: { stringValue: 'hello' } },
            ],
          },
          scopeLogs: [
            {
              scope: { name: 'agent-telemetry', version: '0.1.0' },
              logRecords: [
                {
                  timeUnixNano: '1700000000000000000',
                  observedTimeUnixNano: '1700000000000000000',
                  severityNumber: 9,
                  severityText: 'INFO',
                  eventName: 'mcp_server.call',
                  attributes: [
                    { key: 'event.name', value: { stringValue: 'mcp_server.call' } },
                    { key: 'kind', value: { stringValue: 'mcp_server_call' } },
                    { key: 'gen_ai.tool.name', value: { stringValue: 'probe' } },
                    { key: 'mcp.method.name', value: { stringValue: 'tools/call' } },
                    {
                      key: 'mcp_server.call_id',
                      value: { stringValue: '01HZCALL00000000000000001' },
                    },
                    { key: 'mcp_server.status', value: { stringValue: 'ok' } },
                    { key: 'mcp_server.total_ms', value: { intValue: '120' } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
  });
});

describe('parseResourceAttributes', () => {
  it('parses two comma-separated key=value pairs', () => {
    expect(parseResourceAttributes('a=1,b=2')).toEqual({ a: '1', b: '2' });
  });

  it('splits on the first "=" only, trims both sides, and skips malformed entries', () => {
    const result = parseResourceAttributes('a=1,bad,=x,c=,d=a=b, e = 5 ');
    expect(result).toEqual({ a: '1', d: 'a=b', e: '5' });
  });

  it('keeps a value as the literal text when percent-decoding throws', () => {
    expect(parseResourceAttributes('bad=%ZZ')).toEqual({ bad: '%ZZ' });
  });

  it('returns an empty object for undefined or an empty string', () => {
    expect(parseResourceAttributes(undefined)).toEqual({});
    expect(parseResourceAttributes('')).toEqual({});
  });
});

describe('toAnyValue', () => {
  it('converts an integer to intValue as a string', () => {
    expect(toAnyValue(120)).toEqual({ intValue: '120' });
  });

  it('converts a non-integer number to doubleValue', () => {
    expect(toAnyValue(0.42)).toEqual({ doubleValue: 0.42 });
  });

  it('converts a boolean to boolValue', () => {
    expect(toAnyValue(true)).toEqual({ boolValue: true });
  });

  it('truncates a 3000-character string to 2048 bytes, cut on a code-point boundary', () => {
    const long = 'a'.repeat(3000);
    const result = toAnyValue(long);
    if (!('stringValue' in result)) {
      throw new Error('expected a stringValue entry');
    }
    expect(new TextEncoder().encode(result.stringValue).length).toBeLessThanOrEqual(2048);
    expect(result.stringValue).toBe('a'.repeat(2048));
  });
});

describe('buildResourceAttributes', () => {
  it('prefers the Event run_id over the same key from the environment', () => {
    const event: RunStartEvent = { ...runStartEvent(), run_id: 'event-run' };

    const attributes = buildResourceAttributes({
      serviceName: 'test-service',
      event,
      envAttributes: { run_id: 'env-run' },
    });

    const runIdAttribute = attributes.find((attribute) => attribute.key === 'run_id');
    if (runIdAttribute === undefined) {
      throw new Error('expected a run_id attribute');
    }
    expect(runIdAttribute.value).toEqual({ stringValue: 'event-run' });
  });

  it('emits no entry for an absent optional field', () => {
    const attributes = buildResourceAttributes({
      serviceName: 'test-service',
      event: runStartEvent(),
      envAttributes: {},
    });

    expect(attributes.some((attribute) => attribute.key === 'variant')).toBe(false);
    expect(attributes.some((attribute) => attribute.key === 'config')).toBe(false);
  });
});

describe('buildRecordAttributes', () => {
  it('gives event.name and the eventName argument the same value', () => {
    const attributes = buildRecordAttributes(runStartEvent(), MCP_SERVER_CALL);

    const eventNameAttribute = attributes.find((attribute) => attribute.key === 'event.name');
    if (eventNameAttribute === undefined) {
      throw new Error('expected an event.name attribute');
    }
    expect(eventNameAttribute.value).toEqual({ stringValue: MCP_SERVER_CALL });
  });
});

describe('buildLogsPayload, body and grouping', () => {
  it('leaves body unset on every produced log record', () => {
    const payload = buildLogsPayload({
      serviceName: 'test-service',
      scopeName: 'agent-telemetry',
      scopeVersion: '0.1.0',
      records: [
        { event: runStartEvent(), eventName: MCP_SERVER_CALL, timeUnixNano: '1700000000000000000' },
      ],
      envAttributes: {},
    });

    for (const resourceLog of payload.resourceLogs) {
      for (const scopeLog of resourceLog.scopeLogs) {
        for (const logRecord of scopeLog.logRecords) {
          expect('body' in logRecord).toBe(false);
        }
      }
    }
  });

  it('groups two Events sharing one resource into one resourceLogs entry, and two differing Events into two', () => {
    const eventA = runStartEvent();
    const eventB: RunStartEvent = { ...eventA, session_id: 'session-b' };
    const eventC: RunStartEvent = { ...eventA, rep: 1 };

    const differing = buildLogsPayload({
      serviceName: 'test-service',
      scopeName: 'agent-telemetry',
      scopeVersion: '0.1.0',
      records: [
        { event: eventA, eventName: MCP_SERVER_CALL, timeUnixNano: '1' },
        { event: eventB, eventName: MCP_SERVER_CALL, timeUnixNano: '2' },
      ],
      envAttributes: {},
    });
    expect(differing.resourceLogs).toHaveLength(2);

    const shared = buildLogsPayload({
      serviceName: 'test-service',
      scopeName: 'agent-telemetry',
      scopeVersion: '0.1.0',
      records: [
        { event: eventA, eventName: MCP_SERVER_CALL, timeUnixNano: '1' },
        { event: eventC, eventName: MCP_SERVER_CALL, timeUnixNano: '2' },
      ],
      envAttributes: {},
    });
    const [resourceLog] = shared.resourceLogs;
    if (resourceLog === undefined) {
      throw new Error('expected one resourceLogs entry');
    }
    expect(shared.resourceLogs).toHaveLength(1);

    const [scopeLog] = resourceLog.scopeLogs;
    if (scopeLog === undefined) {
      throw new Error('expected one scopeLogs entry');
    }
    expect(scopeLog.logRecords).toHaveLength(2);
  });
});
