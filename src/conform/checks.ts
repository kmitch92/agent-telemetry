import type { AnyValue } from '../events/otlp-payload.js';
import type { CheckResult } from '../schema/conform.js';
import type { AttributeRule, AttributeValueForm } from './contract.js';
import {
  ERROR_TYPE_CLOSED_SET,
  EXPECTED_CALL_COUNT,
  MAX_ATTRIBUTE_VALUE_BYTES,
  MUST_ATTRIBUTES,
  PRIMARY_EVENT_NAME,
  SECONDARY_START_EVENT_NAME,
  SHOULD_ATTRIBUTES,
} from './contract.js';
import type { ConformRecord } from './records.js';

/**
 * Runs the full MCP (Model Context Protocol) server event contract against
 * one set of flattened OTLP (OpenTelemetry Protocol) log records. Pure: no
 * `node:*` import, no file system, no network, no process access.
 */

export interface CheckInput {
  records: readonly ConformRecord[];
  runId: string;
  nonces: readonly string[];
  invalidRequestId: number;
}

function namesEvent(record: ConformRecord, eventName: string): boolean {
  if (record.eventName === eventName) {
    return true;
  }
  const nameAttribute = record.attributes['event.name'];
  return (
    nameAttribute !== undefined &&
    'stringValue' in nameAttribute &&
    nameAttribute.stringValue === eventName
  );
}

/**
 * A candidate with no `run_id` key at all is accepted into the selected set,
 * deliberately. That is the only way the `resource.run_id` row can ever fail
 * outright, rather than silently shrinking the selected count by excluding
 * the very records that row exists to check.
 */
function belongsToRun(record: ConformRecord, runId: string): boolean {
  const runIdValue = record.resource['run_id'];
  if (runIdValue === undefined) {
    return true;
  }
  return 'stringValue' in runIdValue && runIdValue.stringValue === runId;
}

function selectRecords(records: readonly ConformRecord[], runId: string): ConformRecord[] {
  return records.filter(
    (record) => namesEvent(record, PRIMARY_EVENT_NAME) && belongsToRun(record, runId),
  );
}

function valueForm(value: AnyValue): AttributeValueForm {
  if ('stringValue' in value) {
    return 'stringValue';
  }
  if ('intValue' in value) {
    return 'intValue';
  }
  if ('doubleValue' in value) {
    return 'doubleValue';
  }
  return 'boolValue';
}

function stringValueOf(value: AnyValue | undefined): string | undefined {
  return value !== undefined && 'stringValue' in value ? value.stringValue : undefined;
}

function byteLength(value: AnyValue): number {
  const encoder = new TextEncoder();
  if ('stringValue' in value) {
    return encoder.encode(value.stringValue).length;
  }
  if ('intValue' in value) {
    return encoder.encode(value.intValue).length;
  }
  if ('doubleValue' in value) {
    return encoder.encode(String(value.doubleValue)).length;
  }
  return encoder.encode(String(value.boolValue)).length;
}

function attributeMatchesRule(value: AnyValue | undefined, rule: AttributeRule): boolean {
  if (value === undefined || valueForm(value) !== rule.form) {
    return false;
  }
  if (rule.closedSet === undefined) {
    return true;
  }
  return 'stringValue' in value && rule.closedSet.includes(value.stringValue);
}

function checkEventsCount(selected: readonly ConformRecord[]): CheckResult {
  const pass = selected.length === EXPECTED_CALL_COUNT;
  return {
    id: 'events.count',
    severity: 'must',
    pass,
    detail: `found ${String(selected.length)} selected ${PRIMARY_EVENT_NAME} records, expected ${String(EXPECTED_CALL_COUNT)}`,
  };
}

function recordNamesEventBothWays(record: ConformRecord): boolean {
  if (record.eventName !== PRIMARY_EVENT_NAME) {
    return false;
  }
  const nameAttribute = record.attributes['event.name'];
  return (
    nameAttribute !== undefined &&
    'stringValue' in nameAttribute &&
    nameAttribute.stringValue === PRIMARY_EVENT_NAME
  );
}

function checkEventNameBoth(selected: readonly ConformRecord[]): CheckResult {
  const failingCount = selected.filter((record) => !recordNamesEventBothWays(record)).length;
  const pass = failingCount === 0;
  return {
    id: 'events.event_name_both',
    severity: 'must',
    pass,
    detail: pass
      ? `every selected record carries eventName and event.name both set to ${PRIMARY_EVENT_NAME}`
      : `${String(failingCount)} of ${String(selected.length)} selected records lack eventName or event.name set to ${PRIMARY_EVENT_NAME}`,
  };
}

function callIdKey(record: ConformRecord, index: number): string {
  const value = record.attributes['mcp_server.call_id'];
  if (value !== undefined && 'stringValue' in value) {
    return value.stringValue;
  }
  return `__missing_call_id_${String(index)}__`;
}

function checkCallIdUnique(selected: readonly ConformRecord[]): CheckResult {
  const keys = selected.map((record, index) => callIdKey(record, index));
  const distinctCount = new Set(keys).size;
  const pass = distinctCount === selected.length;
  return {
    id: 'call_id.unique',
    severity: 'must',
    pass,
    detail: pass
      ? `all ${String(selected.length)} selected records carry a distinct mcp_server.call_id`
      : `only ${String(distinctCount)} distinct mcp_server.call_id values across ${String(selected.length)} selected records`,
  };
}

function checkMustAttribute(selected: readonly ConformRecord[], rule: AttributeRule): CheckResult {
  const failingCount = selected.filter(
    (record) => !attributeMatchesRule(record.attributes[rule.key], rule),
  ).length;
  const pass = failingCount === 0;
  return {
    id: `must.${rule.key}`,
    severity: 'must',
    pass,
    detail: pass
      ? `every selected record carries ${rule.key} in the ${rule.form} form`
      : `${String(failingCount)} of ${String(selected.length)} selected records lack ${rule.key} in the ${rule.form} form`,
  };
}

function checkErrorTypeByStatus(selected: readonly ConformRecord[]): CheckResult {
  let failingCount = 0;
  for (const record of selected) {
    const status = stringValueOf(record.attributes['mcp_server.status']);
    const errorType = record.attributes['mcp_server.error.type'];
    if (status === 'error') {
      const errorTypeValue = stringValueOf(errorType);
      if (errorTypeValue === undefined || !ERROR_TYPE_CLOSED_SET.includes(errorTypeValue)) {
        failingCount += 1;
      }
    } else if (status === 'ok' && errorType !== undefined) {
      failingCount += 1;
    }
  }
  const pass = failingCount === 0;
  return {
    id: 'must.mcp_server.error.type',
    severity: 'must',
    pass,
    detail: pass
      ? 'mcp_server.error.type is present exactly when mcp_server.status is error, and absent when ok'
      : `${String(failingCount)} of ${String(selected.length)} selected records mishandle mcp_server.error.type for their mcp_server.status`,
  };
}

interface InvalidCandidate {
  record: ConformRecord;
  reason: 'mcp.request.id' | 'latest timeUnixNano';
}

/**
 * Falls back to the record with the greatest `timeUnixNano` when no record
 * carries the invalid request's `mcp.request.id`. The fallback is
 * best-effort, because `mcp.request.id` is only a SHOULD attribute, so a
 * conforming server may never send it at all.
 */
function findInvalidCandidate(
  selected: readonly ConformRecord[],
  invalidRequestId: number,
): InvalidCandidate | undefined {
  const byRequestId = selected.find(
    (record) => stringValueOf(record.attributes['mcp.request.id']) === String(invalidRequestId),
  );
  if (byRequestId !== undefined) {
    return { record: byRequestId, reason: 'mcp.request.id' };
  }

  let latest: ConformRecord | undefined;
  let latestTime = -1n;
  for (const record of selected) {
    const time = BigInt(record.timeUnixNano);
    if (latest === undefined || time > latestTime) {
      latest = record;
      latestTime = time;
    }
  }
  return latest === undefined ? undefined : { record: latest, reason: 'latest timeUnixNano' };
}

function checkInvalidRequestError(
  selected: readonly ConformRecord[],
  invalidRequestId: number,
): CheckResult {
  const found = findInvalidCandidate(selected, invalidRequestId);
  if (found === undefined) {
    return {
      id: 'invalid_request.error',
      severity: 'must',
      pass: false,
      detail: 'no record was found in the selected set to check as the invalid request',
    };
  }

  const { record, reason } = found;
  const status = stringValueOf(record.attributes['mcp_server.status']);
  const errorType = stringValueOf(record.attributes['mcp_server.error.type']);
  const pass =
    status === 'error' && errorType !== undefined && ERROR_TYPE_CLOSED_SET.includes(errorType);

  return {
    id: 'invalid_request.error',
    severity: 'must',
    pass,
    detail: pass
      ? `the invalid request record, found by ${reason}, carries mcp_server.status error and a closed-set mcp_server.error.type`
      : `the invalid request record, found by ${reason}, does not carry mcp_server.status error with a closed-set mcp_server.error.type`,
  };
}

function checkAttributeSize(selected: readonly ConformRecord[]): CheckResult {
  for (const record of selected) {
    const entries = [...Object.entries(record.attributes), ...Object.entries(record.resource)];
    for (const [key, value] of entries) {
      const length = byteLength(value);
      if (length > MAX_ATTRIBUTE_VALUE_BYTES) {
        return {
          id: 'attribute.size',
          severity: 'must',
          pass: false,
          detail: `${key} is ${String(length)} bytes, over the ${String(MAX_ATTRIBUTE_VALUE_BYTES)}-byte limit`,
        };
      }
    }
  }
  return {
    id: 'attribute.size',
    severity: 'must',
    pass: true,
    detail: `every attribute and resource value across ${String(selected.length)} selected records is within ${String(MAX_ATTRIBUTE_VALUE_BYTES)} bytes`,
  };
}

/**
 * A literal "no part of the request text" rule is not decidable: this
 * checker cannot see the internals of an arbitrary third-party MCP server.
 * The nonce this checker sent in each request stands in for that rule
 * instead, with no false positive, because a nonce is generated fresh for
 * this run and cannot otherwise appear in any output.
 */
function checkNoRequestText(
  selected: readonly ConformRecord[],
  nonces: readonly string[],
): CheckResult {
  for (const record of selected) {
    const entries = [...Object.entries(record.attributes), ...Object.entries(record.resource)];
    for (const [key, value] of entries) {
      if ('stringValue' in value && nonces.some((nonce) => value.stringValue.includes(nonce))) {
        return {
          id: 'attribute.no_request_text',
          severity: 'must',
          pass: false,
          detail: `${key} echoes back a nonce this checker sent in a request`,
        };
      }
    }
  }
  return {
    id: 'attribute.no_request_text',
    severity: 'must',
    pass: true,
    detail: `no attribute or resource value across ${String(selected.length)} selected records echoes a sent nonce`,
  };
}

function checkResourceRunId(selected: readonly ConformRecord[], runId: string): CheckResult {
  const failingCount = selected.filter((record) => {
    const value = record.resource['run_id'];
    return !(value !== undefined && 'stringValue' in value && value.stringValue === runId);
  }).length;
  const pass = failingCount === 0;
  return {
    id: 'resource.run_id',
    severity: 'must',
    pass,
    detail: pass
      ? `every selected record carries resource.run_id equal to ${runId}`
      : `${String(failingCount)} of ${String(selected.length)} selected records lack resource.run_id equal to ${runId}`,
  };
}

function checkShouldAttribute(
  selected: readonly ConformRecord[],
  rule: AttributeRule,
): CheckResult | undefined {
  const missingCount = selected.filter(
    (record) => record.attributes[rule.key] === undefined,
  ).length;
  if (missingCount === 0) {
    return undefined;
  }

  const base = `${String(missingCount)} of ${String(selected.length)} selected records lack ${rule.key}`;
  const detail =
    rule.key === 'mcp_server.upstream_ms'
      ? `${base} (outside observer: no observer outside the server can ever tell whether it made an upstream request)`
      : base;

  return {
    id: `should.${rule.key}`,
    severity: 'warn',
    pass: false,
    detail,
  };
}

function checkSecondaryStart(records: readonly ConformRecord[]): CheckResult | undefined {
  const seen = records.some((record) => namesEvent(record, SECONDARY_START_EVENT_NAME));
  if (seen) {
    return undefined;
  }
  return {
    id: 'secondary.mcp_server.start',
    severity: 'warn',
    pass: false,
    detail: `no record names ${SECONDARY_START_EVENT_NAME} anywhere in the input`,
  };
}

export function runChecks(input: CheckInput): CheckResult[] {
  const selected = selectRecords(input.records, input.runId);

  const mustRows: CheckResult[] = [
    checkEventsCount(selected),
    checkEventNameBoth(selected),
    checkCallIdUnique(selected),
    ...MUST_ATTRIBUTES.map((rule) => checkMustAttribute(selected, rule)),
    checkErrorTypeByStatus(selected),
    checkInvalidRequestError(selected, input.invalidRequestId),
    checkAttributeSize(selected),
    checkNoRequestText(selected, input.nonces),
    checkResourceRunId(selected, input.runId),
  ];

  const warnRows: CheckResult[] = [];
  for (const rule of SHOULD_ATTRIBUTES) {
    const row = checkShouldAttribute(selected, rule);
    if (row !== undefined) {
      warnRows.push(row);
    }
  }

  const secondaryStartRow = checkSecondaryStart(input.records);
  if (secondaryStartRow !== undefined) {
    warnRows.push(secondaryStartRow);
  }

  return [...mustRows, ...warnRows];
}
