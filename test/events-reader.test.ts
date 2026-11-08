import { describe, expect, it } from 'vitest';
import { classifyLine, UNKNOWN_AGENT_KEY } from '../src/events/line.js';
import { countEventLines, readEventsFile } from '../src/events/read.js';

const FIXTURE_PATH = 'test/fixtures/events/reader-sample.jsonl';
const MISSING_PATH = 'test/fixtures/events/missing.jsonl';

function envelopeWithTwoLogRecords(): string {
  return JSON.stringify({
    resourceLogs: [
      {
        resource: {
          attributes: [
            { key: 'agent', value: { stringValue: 'claude-code' } },
            { key: 'session_id', value: { stringValue: 'session-x' } },
            { key: 'project', value: { stringValue: 'proj-x' } },
          ],
        },
        scopeLogs: [
          {
            scope: { name: 'agent-telemetry', version: '0.1.0' },
            logRecords: [
              {
                timeUnixNano: '1',
                observedTimeUnixNano: '1',
                severityNumber: 9,
                severityText: 'INFO',
                eventName: 'claude_code.tool_decision',
                attributes: [{ key: 'kind', value: { stringValue: 'tool_decision' } }],
              },
              {
                timeUnixNano: '2',
                observedTimeUnixNano: '2',
                severityNumber: 9,
                severityText: 'INFO',
                eventName: 'claude_code.session_start',
                attributes: [{ key: 'kind', value: { stringValue: 'session_start' } }],
              },
            ],
          },
        ],
      },
    ],
  });
}

function envelopeWithBadStatusCode(): string {
  return JSON.stringify({
    resourceLogs: [
      {
        resource: {
          attributes: [
            { key: 'agent', value: { stringValue: 'claude-code' } },
            { key: 'session_id', value: { stringValue: 'session-x' } },
            { key: 'project', value: { stringValue: 'proj-x' } },
          ],
        },
        scopeLogs: [
          {
            scope: { name: 'agent-telemetry', version: '0.1.0' },
            logRecords: [
              {
                timeUnixNano: '1',
                observedTimeUnixNano: '1',
                severityNumber: 17,
                severityText: 'ERROR',
                eventName: 'claude_code.api_error',
                attributes: [
                  { key: 'kind', value: { stringValue: 'api_error' } },
                  { key: 'error_type', value: { stringValue: 'overloaded_error' } },
                  { key: 'status_code', value: { intValue: 'not-a-number' } },
                ],
              },
            ],
          },
        ],
      },
    ],
  });
}

describe('classifyLine', () => {
  it('returns an empty array for an empty or whitespace-only line', () => {
    expect(classifyLine('')).toEqual([]);
    expect(classifyLine('   ')).toEqual([]);
  });

  it.each(['42', '"text"', 'null', '[1,2]'])(
    'returns one malformed outcome for the valid non-object JSON value %s',
    (line) => {
      const outcomes = classifyLine(line);
      expect(outcomes).toHaveLength(1);
      const [outcome] = outcomes;
      if (outcome === undefined) {
        throw new Error('expected one outcome');
      }
      expect(outcome.outcome).toBe('malformed');
    },
  );

  it('returns unknown_kind with UNKNOWN_AGENT_KEY when the candidate has no agent key', () => {
    const line = JSON.stringify({
      kind: 'bogus_kind',
      session_id: 'session-x',
      project: 'proj-x',
    });

    const outcomes = classifyLine(line);
    expect(outcomes).toHaveLength(1);
    const [outcome] = outcomes;
    if (outcome === undefined || outcome.outcome !== 'unknown_kind') {
      throw new Error('expected one unknown_kind outcome');
    }
    expect(outcome.agent).toBe(UNKNOWN_AGENT_KEY);
  });

  it('returns malformed for a known kind whose body fails schema validation', () => {
    const line = JSON.stringify({
      kind: 'model_call',
      agent: 'claude-code',
      session_id: 'session-x',
      project: 'proj-x',
    });

    const outcomes = classifyLine(line);
    expect(outcomes).toHaveLength(1);
    const [outcome] = outcomes;
    if (outcome === undefined) {
      throw new Error('expected one outcome');
    }
    expect(outcome.outcome).toBe('malformed');
  });

  it('returns one malformed outcome when an OTLP envelope resourceLogs is not an array', () => {
    const line = JSON.stringify({ resourceLogs: 'not-an-array' });

    const outcomes = classifyLine(line);
    expect(outcomes).toHaveLength(1);
    const [outcome] = outcomes;
    if (outcome === undefined) {
      throw new Error('expected one outcome');
    }
    expect(outcome.outcome).toBe('malformed');
  });

  it('returns malformed when an OTLP log record intValue attribute is not numeric', () => {
    const outcomes = classifyLine(envelopeWithBadStatusCode());
    expect(outcomes).toHaveLength(1);
    const [outcome] = outcomes;
    if (outcome === undefined) {
      throw new Error('expected one outcome');
    }
    expect(outcome.outcome).toBe('malformed');
  });

  it('returns one outcome per log record when an OTLP envelope carries two in one scopeLogs entry', () => {
    const outcomes = classifyLine(envelopeWithTwoLogRecords());
    expect(outcomes).toHaveLength(2);
  });

  it('returns malformed when a log record attribute value is not a valid AnyValue', () => {
    const line = JSON.stringify({
      resourceLogs: [
        {
          resource: {
            attributes: [
              { key: 'agent', value: { stringValue: 'claude-code' } },
              { key: 'session_id', value: { stringValue: 'session-x' } },
              { key: 'project', value: { stringValue: 'proj-x' } },
            ],
          },
          scopeLogs: [
            {
              scope: { name: 'agent-telemetry', version: '0.1.0' },
              logRecords: [
                {
                  timeUnixNano: '1',
                  observedTimeUnixNano: '1',
                  severityNumber: 17,
                  severityText: 'ERROR',
                  eventName: 'claude_code.api_error',
                  attributes: [
                    { key: 'kind', value: { stringValue: 'api_error' } },
                    { key: 'error_type', value: { stringValue: 'overloaded_error' } },
                    { key: 'status_code', value: { bytesValue: 'abc' } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });

    const outcomes = classifyLine(line);
    expect(outcomes).toHaveLength(1);
    const [outcome] = outcomes;
    if (outcome === undefined) {
      throw new Error('expected one outcome');
    }
    expect(outcome.outcome).toBe('malformed');
  });

  it('returns malformed for every log record when a resource attribute is not a valid AnyValue', () => {
    const line = JSON.stringify({
      resourceLogs: [
        {
          resource: {
            attributes: [
              { key: 'agent', value: { bytesValue: 'abc' } },
              { key: 'session_id', value: { stringValue: 'session-x' } },
              { key: 'project', value: { stringValue: 'proj-x' } },
            ],
          },
          scopeLogs: [
            {
              scope: { name: 'agent-telemetry', version: '0.1.0' },
              logRecords: [
                {
                  timeUnixNano: '1',
                  observedTimeUnixNano: '1',
                  severityNumber: 17,
                  severityText: 'ERROR',
                  eventName: 'claude_code.api_error',
                  attributes: [
                    { key: 'kind', value: { stringValue: 'api_error' } },
                    { key: 'error_type', value: { stringValue: 'overloaded_error' } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });

    const outcomes = classifyLine(line);
    expect(outcomes).toHaveLength(1);
    const [outcome] = outcomes;
    if (outcome === undefined) {
      throw new Error('expected one outcome');
    }
    expect(outcome.outcome).toBe('malformed');
  });

  it('decodes a boolValue attribute into a boolean on the Event', () => {
    const line = JSON.stringify({
      resourceLogs: [
        {
          resource: {
            attributes: [
              { key: 'agent', value: { stringValue: 'claude-code' } },
              { key: 'session_id', value: { stringValue: 'session-x' } },
              { key: 'project', value: { stringValue: 'proj-x' } },
            ],
          },
          scopeLogs: [
            {
              scope: { name: 'agent-telemetry', version: '0.1.0' },
              logRecords: [
                {
                  timeUnixNano: '1',
                  observedTimeUnixNano: '1',
                  severityNumber: 9,
                  severityText: 'INFO',
                  eventName: 'claude_code.tool_call',
                  attributes: [
                    { key: 'kind', value: { stringValue: 'tool_call' } },
                    { key: 'tool', value: { stringValue: 'probe_echo' } },
                    { key: 'tool_type', value: { stringValue: 'mcp' } },
                    { key: 'success', value: { boolValue: true } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });

    const outcomes = classifyLine(line);
    expect(outcomes).toHaveLength(1);
    const [outcome] = outcomes;
    if (outcome === undefined || outcome.outcome !== 'event') {
      throw new Error('expected one event outcome');
    }

    const { event } = outcome.record;
    expect(event.kind).toBe('tool_call');
    if (event.kind === 'tool_call') {
      expect(event.success).toBe(true);
    }
  });

  it('decodes a doubleValue attribute into a number on the Event', () => {
    const line = JSON.stringify({
      resourceLogs: [
        {
          resource: {
            attributes: [
              { key: 'agent', value: { stringValue: 'claude-code' } },
              { key: 'session_id', value: { stringValue: 'session-x' } },
              { key: 'project', value: { stringValue: 'proj-x' } },
            ],
          },
          scopeLogs: [
            {
              scope: { name: 'agent-telemetry', version: '0.1.0' },
              logRecords: [
                {
                  timeUnixNano: '1',
                  observedTimeUnixNano: '1',
                  severityNumber: 9,
                  severityText: 'INFO',
                  eventName: 'claude_code.mcp_server_call',
                  attributes: [
                    { key: 'kind', value: { stringValue: 'mcp_server_call' } },
                    { key: 'mcp_server.call_id', value: { stringValue: 'call-1' } },
                    { key: 'mcp.method.name', value: { stringValue: 'tools/call' } },
                    { key: 'gen_ai.tool.name', value: { stringValue: 'probe_echo' } },
                    { key: 'mcp_server.total_ms', value: { intValue: '12' } },
                    { key: 'mcp_server.status', value: { stringValue: 'ok' } },
                    { key: 'mcp_server.route.confidence', value: { doubleValue: 0.75 } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });

    const outcomes = classifyLine(line);
    expect(outcomes).toHaveLength(1);
    const [outcome] = outcomes;
    if (outcome === undefined || outcome.outcome !== 'event') {
      throw new Error('expected one event outcome');
    }

    const { event } = outcome.record;
    expect(event.kind).toBe('mcp_server_call');
    if (event.kind === 'mcp_server_call') {
      expect(event['mcp_server.route.confidence']).toBe(0.75);
    }
  });
});

describe('readEventsFile', () => {
  it('reads the fixture and classifies every line', async () => {
    const result = await readEventsFile(FIXTURE_PATH);

    expect(result.events).toHaveLength(7);
    expect(result.records).toHaveLength(7);
    expect(result.unknownKindsByAgent).toEqual({ 'claude-code': 1, codex: 1 });
    expect(result.malformed).toBe(1);
    expect(result.lines).toBe(10);
  });

  it('carries the api_error Event decoded from the OTLP envelope on the last line', async () => {
    const result = await readEventsFile(FIXTURE_PATH);

    const apiErrorEvent = result.events.find((event) => event.kind === 'api_error');
    if (apiErrorEvent === undefined) {
      throw new Error('expected an api_error Event');
    }

    expect(apiErrorEvent.error_type).toBe('overloaded_error');
    expect(apiErrorEvent.status_code).toBe(529);
    expect(apiErrorEvent.attempt).toBe(2);
    expect(apiErrorEvent.session_id).toBe('session-a');
    expect(apiErrorEvent.run_id).toBe('run-1');
    expect('service.name' in apiErrorEvent).toBe(false);
  });

  it('carries timeUnixNano and eventName on the record built from the OTLP envelope', async () => {
    const result = await readEventsFile(FIXTURE_PATH);

    const apiErrorRecord = result.records.find((record) => record.event.kind === 'api_error');
    if (apiErrorRecord === undefined) {
      throw new Error('expected an api_error record');
    }

    expect(apiErrorRecord.timeUnixNano).toBe('1762560000000000000');
    expect(apiErrorRecord.eventName).toBe('claude_code.api_error');
  });

  it('leaves timeUnixNano and eventName undefined on every record built from a flat line', async () => {
    const result = await readEventsFile(FIXTURE_PATH);

    const flatRecords = result.records.filter((record) => record.event.kind !== 'api_error');
    expect(flatRecords).toHaveLength(6);
    for (const record of flatRecords) {
      expect(record.timeUnixNano).toBeUndefined();
      expect(record.eventName).toBeUndefined();
    }
  });

  it('resolves to an empty result for a missing file, without rejecting', async () => {
    const result = await readEventsFile(MISSING_PATH);

    expect(result).toEqual({
      events: [],
      records: [],
      unknownKindsByAgent: {},
      malformed: 0,
      lines: 0,
    });
  });
});

describe('countEventLines', () => {
  it('counts the non-empty lines in the fixture', async () => {
    expect(await countEventLines(FIXTURE_PATH)).toBe(10);
  });

  it('returns 0 for a missing file', async () => {
    expect(await countEventLines(MISSING_PATH)).toBe(0);
  });
});
