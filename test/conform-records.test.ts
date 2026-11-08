import { describe, expect, it } from 'vitest';
import type { AnyValue } from '../src/events/otlp-payload.js';
import { parseConformLines } from '../src/conform/records.js';
import { ConformOtlpLineSchema } from '../src/schema/conform.js';

/**
 * Minimal, locally-owned fixture shapes for building OTLP (OpenTelemetry
 * Protocol) envelopes by hand. These mirror the lenient structure
 * `parseConformLines` accepts, without depending on the schema module's
 * inferred types.
 */
interface FixtureAttribute {
  key: string;
  value: AnyValue;
}

interface FixtureLogRecord {
  timeUnixNano: string;
  eventName?: string;
  attributes: FixtureAttribute[];
}

interface FixtureScopeLogs {
  scope?: { name: string };
  logRecords: FixtureLogRecord[];
}

interface FixtureResourceLogs {
  resource: { attributes: FixtureAttribute[] };
  scopeLogs: FixtureScopeLogs[];
}

interface FixtureOtlpLine {
  resourceLogs: FixtureResourceLogs[];
}

function attr(key: string, value: AnyValue): FixtureAttribute {
  return { key, value };
}

function expectDefined<T>(value: T | undefined, message: string): T {
  if (value === undefined) {
    throw new Error(message);
  }
  return value;
}

describe('parseConformLines, a conforming envelope', () => {
  it('yields one record matching the worked example', () => {
    const line: FixtureOtlpLine = {
      resourceLogs: [
        {
          resource: {
            attributes: [
              attr('service.name', { stringValue: 'example-mcp-server' }),
              attr('run_id', { stringValue: 'conform-01JB3X9K7ZC2V9H8G5T1Q6R4N8' }),
            ],
          },
          scopeLogs: [
            {
              scope: { name: 'example-mcp-server' },
              logRecords: [
                {
                  timeUnixNano: '1730000000123456789',
                  eventName: 'mcp_server.call',
                  attributes: [
                    attr('event.name', { stringValue: 'mcp_server.call' }),
                    attr('mcp_server.call_id', { stringValue: '01JB3XA1M5D3W7K2P9Q0R6T8V2' }),
                    attr('mcp.method.name', { stringValue: 'tools/call' }),
                    attr('gen_ai.tool.name', { stringValue: 'lookup' }),
                    attr('mcp_server.total_ms', { intValue: '187' }),
                    attr('mcp_server.status', { stringValue: 'ok' }),
                    attr('mcp_server.internal_ms', { intValue: '42' }),
                    attr('mcp_server.upstream_ms', { intValue: '145' }),
                    attr('mcp_server.upstream.service', { stringValue: 'catalogue-lookup' }),
                    attr('mcp_server.upstream.status', { intValue: '200' }),
                    attr('mcp_server.cache', { stringValue: 'miss' }),
                    attr('mcp.request.id', { stringValue: '7' }),
                    attr('service.version', { stringValue: '1.0.0' }),
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    const { records, malformed } = parseConformLines([JSON.stringify(line)]);

    expect(malformed).toBe(0);
    expect(records).toHaveLength(1);
    const record = expectDefined(records[0], 'expected one record');
    expect(record.eventName).toBe('mcp_server.call');
    expect(record.attributes['mcp_server.total_ms']).toEqual({ intValue: '187' });
    expect(record.resource['run_id']).toEqual({
      stringValue: 'conform-01JB3X9K7ZC2V9H8G5T1Q6R4N8',
    });
  });

  it('accepts a log record with no severityText, severityNumber or observedTimeUnixNano', () => {
    const line: FixtureOtlpLine = {
      resourceLogs: [
        {
          resource: { attributes: [attr('service.name', { stringValue: 'svc' })] },
          scopeLogs: [
            {
              logRecords: [
                {
                  timeUnixNano: '1',
                  eventName: 'mcp_server.call',
                  attributes: [attr('mcp.method.name', { stringValue: 'tools/call' })],
                },
              ],
            },
          ],
        },
      ],
    };

    const parsed = ConformOtlpLineSchema.safeParse(line);
    expect(parsed.success).toBe(true);

    const { records, malformed } = parseConformLines([JSON.stringify(line)]);
    expect(malformed).toBe(0);
    expect(records).toHaveLength(1);
  });
});

describe('parseConformLines, malformed input', () => {
  it('counts a non-JSON line as malformed and yields no record', () => {
    const { records, malformed } = parseConformLines(['not json {']);
    expect(malformed).toBe(1);
    expect(records).toHaveLength(0);
  });

  it('counts a JSON line with no resourceLogs key as malformed', () => {
    const { records, malformed } = parseConformLines([JSON.stringify({ foo: 'bar' })]);
    expect(malformed).toBe(1);
    expect(records).toHaveLength(0);
  });

  it('counts a line with an unknown AnyValue attribute form as malformed', () => {
    const line = {
      resourceLogs: [
        {
          resource: { attributes: [{ key: 'service.name', value: { bytesValue: 'x' } }] },
          scopeLogs: [
            {
              logRecords: [
                {
                  timeUnixNano: '1',
                  attributes: [],
                },
              ],
            },
          ],
        },
      ],
    };

    const { records, malformed } = parseConformLines([JSON.stringify(line)]);
    expect(malformed).toBe(1);
    expect(records).toHaveLength(0);
  });
});

describe('parseConformLines, other OTLP signals', () => {
  it('skips a resourceMetrics line without counting it as malformed', () => {
    const line = {
      resourceMetrics: [
        {
          resource: { attributes: [attr('service.name', { stringValue: 'svc' })] },
          scopeMetrics: [],
        },
      ],
    };

    const { records, malformed } = parseConformLines([JSON.stringify(line)]);
    expect(malformed).toBe(0);
    expect(records).toHaveLength(0);
  });

  it('skips a resourceSpans line without counting it as malformed', () => {
    const line = {
      resourceSpans: [
        {
          resource: { attributes: [attr('service.name', { stringValue: 'svc' })] },
          scopeSpans: [],
        },
      ],
    };

    const { records, malformed } = parseConformLines([JSON.stringify(line)]);
    expect(malformed).toBe(0);
    expect(records).toHaveLength(0);
  });

  it('skips a resourceMetrics line amid a conforming line and a non-JSON line', () => {
    const logLine: FixtureOtlpLine = {
      resourceLogs: [
        {
          resource: { attributes: [attr('service.name', { stringValue: 'svc' })] },
          scopeLogs: [
            {
              logRecords: [
                {
                  timeUnixNano: '1',
                  eventName: 'mcp_server.call',
                  attributes: [],
                },
              ],
            },
          ],
        },
      ],
    };

    const metricsLine = {
      resourceMetrics: [
        {
          resource: { attributes: [] },
          scopeMetrics: [],
        },
      ],
    };

    const { records, malformed } = parseConformLines([
      JSON.stringify(logLine),
      JSON.stringify(metricsLine),
      'not json {',
    ]);

    expect(malformed).toBe(1);
    expect(records).toHaveLength(1);
  });
});

describe('parseConformLines, log records with no eventName', () => {
  it('yields eventName undefined and does not count it as malformed', () => {
    const line: FixtureOtlpLine = {
      resourceLogs: [
        {
          resource: { attributes: [attr('service.name', { stringValue: 'svc' })] },
          scopeLogs: [
            {
              logRecords: [
                {
                  timeUnixNano: '1',
                  attributes: [],
                },
              ],
            },
          ],
        },
      ],
    };

    const { records, malformed } = parseConformLines([JSON.stringify(line)]);
    expect(malformed).toBe(0);
    expect(records).toHaveLength(1);
    const record = expectDefined(records[0], 'expected one record');
    expect(record.eventName).toBeUndefined();
  });
});

describe('parseConformLines, blank lines', () => {
  it('skips blank and whitespace-only lines without counting them as malformed', () => {
    const { records, malformed } = parseConformLines(['', '   ', '\t', '  \n'.trim()]);
    expect(malformed).toBe(0);
    expect(records).toHaveLength(0);
  });
});

describe('parseConformLines, several resourceLogs and logRecords entries', () => {
  it('flattens two resourceLogs entries of two logRecords each, in document order', () => {
    function recordFor(eventName: string): FixtureLogRecord {
      return { timeUnixNano: '1', eventName, attributes: [] };
    }

    const line: FixtureOtlpLine = {
      resourceLogs: [
        {
          resource: { attributes: [attr('run_id', { stringValue: 'run-1' })] },
          scopeLogs: [{ logRecords: [recordFor('event-1a'), recordFor('event-1b')] }],
        },
        {
          resource: { attributes: [attr('run_id', { stringValue: 'run-2' })] },
          scopeLogs: [{ logRecords: [recordFor('event-2a'), recordFor('event-2b')] }],
        },
      ],
    };

    const { records, malformed } = parseConformLines([JSON.stringify(line)]);
    expect(malformed).toBe(0);
    expect(records.map((record) => record.eventName)).toEqual([
      'event-1a',
      'event-1b',
      'event-2a',
      'event-2b',
    ]);
  });
});

describe('parseConformLines, duplicate attribute keys', () => {
  it('keeps the last value when a key appears twice in one attribute array', () => {
    const line: FixtureOtlpLine = {
      resourceLogs: [
        {
          resource: { attributes: [attr('run_id', { stringValue: 'run-1' })] },
          scopeLogs: [
            {
              logRecords: [
                {
                  timeUnixNano: '1',
                  eventName: 'mcp_server.call',
                  attributes: [
                    attr('mcp_server.status', { stringValue: 'first' }),
                    attr('mcp_server.status', { stringValue: 'second' }),
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    const { records, malformed } = parseConformLines([JSON.stringify(line)]);
    expect(malformed).toBe(0);
    const record = expectDefined(records[0], 'expected one record');
    expect(record.attributes['mcp_server.status']).toEqual({ stringValue: 'second' });
  });
});
