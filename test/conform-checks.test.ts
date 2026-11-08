import { describe, expect, it } from 'vitest';
import type { AnyValue } from '../src/events/otlp-payload.js';
import type { ConformRecord } from '../src/conform/records.js';
import type { CheckResult } from '../src/schema/conform.js';
import type { AttributeRule } from '../src/conform/contract.js';
import {
  MUST_ATTRIBUTES,
  PRIMARY_EVENT_NAME,
  SECONDARY_START_EVENT_NAME,
  SHOULD_ATTRIBUTES,
} from '../src/conform/contract.js';
import { runChecks } from '../src/conform/checks.js';
import { exitCodeFor } from '../src/conform/table.js';

const RUN_ID = 'conform-TEST';

const NONCE_1 = 'NONCE000000000A1';
const NONCE_2 = 'NONCE000000000A2';
const NONCE_3 = 'NONCE000000000A3';
const NONCE_4 = 'NONCE000000000A4';
const NONCE_5 = 'NONCE000000000A5';
const NONCE_6 = 'NONCE000000000A6';
const NONCES = [NONCE_1, NONCE_2, NONCE_3, NONCE_4, NONCE_5, NONCE_6];

const INVALID_REQUEST_ID = 15;

const BASE_TIME = 1_700_000_000_000_000_000n;

interface BuildInput {
  index: number;
  requestId: number;
  isInvalid: boolean;
}

/** Fills one MUST attribute, per `MUST_ATTRIBUTES`, so the fixture stays honest against the contract. */
function mustAttributeValue(rule: AttributeRule, input: BuildInput): AnyValue {
  switch (rule.key) {
    case 'mcp_server.call_id':
      return { stringValue: `01CALLID${String(input.index).padStart(4, '0')}` };
    case 'mcp.method.name':
      return { stringValue: 'tools/call' };
    case 'gen_ai.tool.name':
      return { stringValue: 'lookup' };
    case 'mcp_server.total_ms':
      return { intValue: String(100 + input.index) };
    case 'mcp_server.status':
      return { stringValue: input.isInvalid ? 'error' : 'ok' };
    default:
      throw new Error(`conformingRecords fixture: unexpected MUST attribute ${rule.key}`);
  }
}

/** Fills one SHOULD attribute, per `SHOULD_ATTRIBUTES`, with a plausible value matching its form. */
function shouldAttributeValue(rule: AttributeRule, input: BuildInput): AnyValue {
  if (rule.key === 'mcp.request.id') {
    return { stringValue: String(input.requestId) };
  }

  switch (rule.form) {
    case 'stringValue':
      return {
        stringValue:
          rule.closedSet !== undefined ? (rule.closedSet[0] ?? 'sample') : `${rule.key}-sample`,
      };
    case 'intValue':
      return { intValue: String(10 + input.index) };
    case 'doubleValue':
      return { doubleValue: 0.42 };
    case 'boolValue':
      return { boolValue: false };
  }
}

function buildCallRecord(input: BuildInput): ConformRecord {
  const attributes: Record<string, AnyValue> = {
    'event.name': { stringValue: PRIMARY_EVENT_NAME },
  };

  for (const rule of MUST_ATTRIBUTES) {
    attributes[rule.key] = mustAttributeValue(rule, input);
  }

  for (const rule of SHOULD_ATTRIBUTES) {
    attributes[rule.key] = shouldAttributeValue(rule, input);
  }

  if (input.isInvalid) {
    attributes['mcp_server.error.type'] = { stringValue: 'bad_request' };
  }

  return {
    eventName: PRIMARY_EVENT_NAME,
    attributes,
    resource: {
      'service.name': { stringValue: 'lookup-mcp-server' },
      run_id: { stringValue: RUN_ID },
    },
    timeUnixNano: String(BASE_TIME + BigInt(input.index)),
  };
}

function buildStartRecord(): ConformRecord {
  return {
    eventName: SECONDARY_START_EVENT_NAME,
    attributes: { 'event.name': { stringValue: SECONDARY_START_EVENT_NAME } },
    resource: {
      'service.name': { stringValue: 'lookup-mcp-server' },
      run_id: { stringValue: RUN_ID },
    },
    timeUnixNano: String(BASE_TIME - 1n),
  };
}

/** The thirteen `mcp_server.call` records: twelve valid calls, then the invalid request. */
function buildCalls(): ConformRecord[] {
  const calls: ConformRecord[] = [];
  for (let index = 0; index < 12; index += 1) {
    calls.push(buildCallRecord({ index, requestId: 3 + index, isInvalid: false }));
  }
  calls.push(buildCallRecord({ index: 12, requestId: INVALID_REQUEST_ID, isInvalid: true }));
  return calls;
}

/**
 * Thirteen fully conforming `mcp_server.call` records plus one
 * `mcp_server.start` record, so the baseline carries zero warnings.
 */
function conformingRecords(): ConformRecord[] {
  return [...buildCalls(), buildStartRecord()];
}

function stringAttr(record: ConformRecord, key: string): string | undefined {
  const value = record.attributes[key];
  if (value !== undefined && 'stringValue' in value) {
    return value.stringValue;
  }
  return undefined;
}

function findInvalidRecord(calls: ConformRecord[]): ConformRecord {
  const found = calls.find(
    (record) => stringAttr(record, 'mcp.request.id') === String(INVALID_REQUEST_ID),
  );
  if (found === undefined) {
    throw new Error('fixture error: invalid request record not found');
  }
  return found;
}

function callAtIndexOrThrow(calls: ConformRecord[], index: number): ConformRecord {
  const record = calls[index];
  if (record === undefined) {
    throw new Error(`fixture error: expected a call record at index ${String(index)}`);
  }
  return record;
}

function runWithCalls(calls: ConformRecord[]): CheckResult[] {
  return runChecks({
    records: [...calls, buildStartRecord()],
    runId: RUN_ID,
    nonces: NONCES,
    invalidRequestId: INVALID_REQUEST_ID,
  });
}

function rowById(results: CheckResult[], id: string): CheckResult {
  const row = results.find((result) => result.id === id);
  if (row === undefined) {
    throw new Error(`expected a check row with id ${id}`);
  }
  return row;
}

function expectRowFails(results: CheckResult[], id: string): void {
  const row = rowById(results, id);
  expect(row.pass).toBe(false);
  expect(row.id).toBe(id);
  expect(exitCodeFor(results)).toBe(1);
}

describe('runChecks - baseline', () => {
  it('passes all 13 MUST checks with zero warnings', () => {
    const results = runChecks({
      records: conformingRecords(),
      runId: RUN_ID,
      nonces: NONCES,
      invalidRequestId: INVALID_REQUEST_ID,
    });

    const mustRows = results.filter((row) => row.severity === 'must');
    expect(mustRows.length).toBe(13);
    for (const row of mustRows) {
      expect(row.pass).toBe(true);
      expect(row.detail.length).toBeGreaterThan(0);
    }

    const warnRows = results.filter((row) => row.severity === 'warn');
    expect(warnRows.length).toBe(0);

    expect(exitCodeFor(results)).toBe(0);
  });
});

describe('runChecks - deviations', () => {
  it('fails events.count with twelve records', () => {
    const calls = structuredClone(buildCalls()).slice(0, 12);
    const results = runWithCalls(calls);
    expectRowFails(results, 'events.count');
  });

  it('fails events.count with fourteen records', () => {
    const calls = [
      ...structuredClone(buildCalls()),
      buildCallRecord({ index: 13, requestId: 16, isInvalid: false }),
    ];
    const results = runWithCalls(calls);
    expectRowFails(results, 'events.count');
  });

  it('fails must.mcp_server.total_ms when the attribute is absent', () => {
    const calls = structuredClone(buildCalls());
    delete callAtIndexOrThrow(calls, 0).attributes['mcp_server.total_ms'];
    const results = runWithCalls(calls);
    expectRowFails(results, 'must.mcp_server.total_ms');
  });

  it('fails must.mcp_server.total_ms when sent in the wrong form', () => {
    const calls = structuredClone(buildCalls());
    callAtIndexOrThrow(calls, 0).attributes['mcp_server.total_ms'] = { stringValue: '5' };
    const results = runWithCalls(calls);
    expectRowFails(results, 'must.mcp_server.total_ms');
  });

  it('fails must.mcp_server.status when the value is outside the closed set', () => {
    const calls = structuredClone(buildCalls());
    callAtIndexOrThrow(calls, 0).attributes['mcp_server.status'] = { stringValue: 'pending' };
    const results = runWithCalls(calls);
    expectRowFails(results, 'must.mcp_server.status');
  });

  it('fails call_id.unique when two records share a call_id', () => {
    const calls = structuredClone(buildCalls());
    const duplicate: AnyValue = { stringValue: 'DUPLICATE-CALL-ID' };
    callAtIndexOrThrow(calls, 0).attributes['mcp_server.call_id'] = duplicate;
    callAtIndexOrThrow(calls, 1).attributes['mcp_server.call_id'] = { ...duplicate };
    const results = runWithCalls(calls);
    expectRowFails(results, 'call_id.unique');
  });

  it('fails must.mcp_server.error.type when present on an ok record', () => {
    const calls = structuredClone(buildCalls());
    callAtIndexOrThrow(calls, 0).attributes['mcp_server.error.type'] = {
      stringValue: 'bad_request',
    };
    const results = runWithCalls(calls);
    expectRowFails(results, 'must.mcp_server.error.type');
  });

  it('fails must.mcp_server.error.type when the value is outside the closed set', () => {
    const calls = structuredClone(buildCalls());
    findInvalidRecord(calls).attributes['mcp_server.error.type'] = { stringValue: 'teapot' };
    const results = runWithCalls(calls);
    expectRowFails(results, 'must.mcp_server.error.type');
  });

  it('fails attribute.size for a 3000-character attribute value, naming the offending key', () => {
    const calls = structuredClone(buildCalls());
    callAtIndexOrThrow(calls, 0).attributes['mcp_server.target'] = {
      stringValue: 'x'.repeat(3000),
    };
    const results = runWithCalls(calls);
    const row = rowById(results, 'attribute.size');
    expect(row.pass).toBe(false);
    expect(row.detail).toContain('mcp_server.target');
    expect(exitCodeFor(results)).toBe(1);
  });

  it('fails attribute.no_request_text for a nonce echoed into mcp_server.error.message, naming that key', () => {
    const calls = structuredClone(buildCalls());
    findInvalidRecord(calls).attributes['mcp_server.error.message'] = {
      stringValue: `upstream failed: ${NONCE_1}`,
    };
    const results = runWithCalls(calls);
    const row = rowById(results, 'attribute.no_request_text');
    expect(row.pass).toBe(false);
    expect(row.detail).toContain('mcp_server.error.message');
    expect(exitCodeFor(results)).toBe(1);
  });

  it('fails resource.run_id when the key is removed from one record', () => {
    const calls = structuredClone(buildCalls());
    delete callAtIndexOrThrow(calls, 0).resource['run_id'];
    const results = runWithCalls(calls);
    expectRowFails(results, 'resource.run_id');
  });

  it('fails invalid_request.error when the invalid record carries ok with no error.type', () => {
    const calls = structuredClone(buildCalls());
    const invalid = findInvalidRecord(calls);
    invalid.attributes['mcp_server.status'] = { stringValue: 'ok' };
    delete invalid.attributes['mcp_server.error.type'];
    const results = runWithCalls(calls);
    expectRowFails(results, 'invalid_request.error');
  });

  it('fails events.event_name_both when eventName is undefined but event.name stays', () => {
    const calls = structuredClone(buildCalls());
    callAtIndexOrThrow(calls, 0).eventName = undefined;
    const results = runWithCalls(calls);
    expectRowFails(results, 'events.event_name_both');
  });

  it('fails must.mcp.method.name when the attribute is removed', () => {
    const calls = structuredClone(buildCalls());
    delete callAtIndexOrThrow(calls, 0).attributes['mcp.method.name'];
    const results = runWithCalls(calls);
    expectRowFails(results, 'must.mcp.method.name');
  });

  it('fails must.gen_ai.tool.name when the attribute is removed', () => {
    const calls = structuredClone(buildCalls());
    delete callAtIndexOrThrow(calls, 0).attributes['gen_ai.tool.name'];
    const results = runWithCalls(calls);
    expectRowFails(results, 'must.gen_ai.tool.name');
  });

  it('fails must.mcp_server.call_id when the attribute is removed', () => {
    const calls = structuredClone(buildCalls());
    delete callAtIndexOrThrow(calls, 0).attributes['mcp_server.call_id'];
    const results = runWithCalls(calls);
    expectRowFails(results, 'must.mcp_server.call_id');
  });

  it('warns once when mcp_server.internal_ms is missing from every record, while every MUST check still passes', () => {
    const calls = structuredClone(buildCalls()).map((record) => {
      delete record.attributes['mcp_server.internal_ms'];
      return record;
    });
    const results = runWithCalls(calls);

    for (const row of results.filter((result) => result.severity === 'must')) {
      expect(row.pass).toBe(true);
    }

    const warnRows = results.filter((row) => row.severity === 'warn');
    expect(warnRows.length).toBe(1);

    const warnRow = rowById(results, 'should.mcp_server.internal_ms');
    expect(warnRow.severity).toBe('warn');
    expect(warnRow.pass).toBe(false);

    expect(exitCodeFor(results)).toBe(0);
  });

  it('names "outside observer" in the mcp_server.upstream_ms warning detail', () => {
    const calls = structuredClone(buildCalls()).map((record) => {
      delete record.attributes['mcp_server.upstream_ms'];
      return record;
    });
    const results = runWithCalls(calls);
    const warnRow = rowById(results, 'should.mcp_server.upstream_ms');
    expect(warnRow.severity).toBe('warn');
    expect(warnRow.pass).toBe(false);
    expect(warnRow.detail).toContain('outside observer');
  });

  it('excludes a candidate whose run_id belongs to another run', () => {
    const foreign = buildCallRecord({ index: 20, requestId: 99, isInvalid: false });
    foreign.resource['run_id'] = { stringValue: 'conform-OTHER' };

    const results = runChecks({
      records: [...conformingRecords(), foreign],
      runId: RUN_ID,
      nonces: NONCES,
      invalidRequestId: INVALID_REQUEST_ID,
    });

    const row = rowById(results, 'events.count');
    expect(row.pass).toBe(true);
    expect(exitCodeFor(results)).toBe(0);
  });

  it('uses mcp.request.id when present, and falls back to the latest timeUnixNano otherwise', () => {
    const baselineResults = runChecks({
      records: conformingRecords(),
      runId: RUN_ID,
      nonces: NONCES,
      invalidRequestId: INVALID_REQUEST_ID,
    });
    const baselineRow = rowById(baselineResults, 'invalid_request.error');
    expect(baselineRow.pass).toBe(true);
    expect(baselineRow.detail).toContain('mcp.request.id');

    const callsWithoutRequestId = structuredClone(buildCalls()).map((record) => {
      delete record.attributes['mcp.request.id'];
      return record;
    });
    const fallbackResults = runWithCalls(callsWithoutRequestId);
    const fallbackRow = rowById(fallbackResults, 'invalid_request.error');
    expect(fallbackRow.pass).toBe(true);
    expect(fallbackRow.detail).toContain('latest timeUnixNano');
  });

  it('returns 13 MUST rows for an empty records array without throwing, and fails overall', () => {
    const results = runChecks({
      records: [],
      runId: RUN_ID,
      nonces: NONCES,
      invalidRequestId: INVALID_REQUEST_ID,
    });

    const mustRows = results.filter((row) => row.severity === 'must');
    expect(mustRows.length).toBe(13);
    expect(exitCodeFor(results)).toBe(1);
  });
});

describe('runChecks - secondary.mcp_server.start', () => {
  it('warns when no mcp_server.start record exists, and stops warning once one is added', () => {
    const calls = structuredClone(buildCalls());

    const resultsWithoutStart = runChecks({
      records: calls,
      runId: RUN_ID,
      nonces: NONCES,
      invalidRequestId: INVALID_REQUEST_ID,
    });
    const warnRow = rowById(resultsWithoutStart, 'secondary.mcp_server.start');
    expect(warnRow.severity).toBe('warn');
    expect(warnRow.pass).toBe(false);

    const resultsWithStart = runChecks({
      records: [...calls, buildStartRecord()],
      runId: RUN_ID,
      nonces: NONCES,
      invalidRequestId: INVALID_REQUEST_ID,
    });
    expect(resultsWithStart.some((row) => row.id === 'secondary.mcp_server.start')).toBe(false);
    for (const row of resultsWithStart.filter((result) => result.severity === 'must')) {
      expect(row.pass).toBe(true);
    }
  });
});
