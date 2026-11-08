import { z } from 'zod';
import type { Event } from '../schema/index.js';

/**
 * Pure OTLP (OpenTelemetry Protocol) logs payload builder. No import from
 * `node:*`, no file or network access: parsing, converting and shaping the
 * payload only.
 */

/** proto3 JSON `AnyValue`: exactly one of the four keys, never more than one. */
export const AnyValueSchema = z.union([
  z.object({ stringValue: z.string() }),
  z.object({ intValue: z.string() }),
  z.object({ doubleValue: z.number() }),
  z.object({ boolValue: z.boolean() }),
]);

export type AnyValue = z.infer<typeof AnyValueSchema>;

export const OtlpAttributeSchema = z.object({
  key: z.string(),
  value: AnyValueSchema,
});

export type OtlpAttribute = z.infer<typeof OtlpAttributeSchema>;

export const OtlpLogRecordSchema = z.object({
  timeUnixNano: z.string(),
  observedTimeUnixNano: z.string(),
  severityNumber: z.number().int(),
  severityText: z.string(),
  eventName: z.string(),
  attributes: z.array(OtlpAttributeSchema),
});

export type OtlpLogRecord = z.infer<typeof OtlpLogRecordSchema>;

export const OtlpScopeLogsSchema = z.object({
  scope: z.object({ name: z.string(), version: z.string() }),
  logRecords: z.array(OtlpLogRecordSchema),
});

export type OtlpScopeLogs = z.infer<typeof OtlpScopeLogsSchema>;

export const OtlpResourceLogsSchema = z.object({
  resource: z.object({ attributes: z.array(OtlpAttributeSchema) }),
  scopeLogs: z.array(OtlpScopeLogsSchema),
});

export type OtlpResourceLogs = z.infer<typeof OtlpResourceLogsSchema>;

export const OtlpLogsPayloadSchema = z.object({
  resourceLogs: z.array(OtlpResourceLogsSchema),
});

export type OtlpLogsPayload = z.infer<typeof OtlpLogsPayloadSchema>;

/** One Event plus the two facts the caller alone knows: its name and its time. */
export interface LogsPayloadRecord {
  event: Event;
  eventName: string;
  timeUnixNano: string;
}

const MAX_ATTRIBUTE_VALUE_BYTES = 2048;

/** The four optional resource keys, in the order SPEC.md gives them. */
const OPTIONAL_RESOURCE_KEYS = ['run_id', 'task', 'variant', 'config'] as const;

/** Every resource key, used to exclude them from the per-record attributes. */
const RESOURCE_ATTRIBUTE_KEY_SET = new Set<string>([
  'agent',
  'session_id',
  'project',
  ...OPTIONAL_RESOURCE_KEYS,
]);

function isAttributeValue(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function truncateToByteLength(input: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(input).length <= maxBytes) {
    return input;
  }

  let result = '';
  let bytes = 0;
  for (const codePoint of input) {
    const codePointBytes = encoder.encode(codePoint).length;
    if (bytes + codePointBytes > maxBytes) {
      break;
    }
    result += codePoint;
    bytes += codePointBytes;
  }
  return result;
}

/**
 * Converts one Event attribute value into proto3 JSON `AnyValue`. A string
 * is truncated to 2048 bytes, cut on a code-point boundary, per SPEC.md's
 * "no attribute value over 2 kilobytes" rule. An integer becomes
 * `intValue` as a string, because proto3 JSON encodes int64 that way.
 */
export function toAnyValue(value: string | number | boolean): AnyValue {
  if (typeof value === 'boolean') {
    return { boolValue: value };
  }
  if (typeof value === 'string') {
    return { stringValue: truncateToByteLength(value, MAX_ATTRIBUTE_VALUE_BYTES) };
  }
  if (Number.isInteger(value)) {
    return { intValue: String(value) };
  }
  return { doubleValue: value };
}

/**
 * Splits `raw` on `,`, then each entry on the first `=` only, trims both
 * sides, percent-decodes the value, and keeps the literal text when
 * decoding throws. Skips an entry with no `=`, an empty key, or an empty
 * value. Returns `{}` for `undefined` or `''`.
 */
export function parseResourceAttributes(raw: string | undefined): Record<string, string> {
  if (raw === undefined || raw === '') {
    return {};
  }

  const result: Record<string, string> = {};
  for (const entry of raw.split(',')) {
    const separatorIndex = entry.indexOf('=');
    if (separatorIndex === -1) {
      continue;
    }

    const key = entry.slice(0, separatorIndex).trim();
    const rawValue = entry.slice(separatorIndex + 1).trim();
    if (key === '' || rawValue === '') {
      continue;
    }

    let value = rawValue;
    try {
      value = decodeURIComponent(rawValue);
    } catch {
      value = rawValue;
    }

    result[key] = value;
  }

  return result;
}

/**
 * Builds the resource attribute array in the fixed order SPEC.md states:
 * `service.name`, `agent`, `session_id`, `project`, `run_id`, `task`,
 * `variant`, `config`, then any remaining environment key sorted
 * lexicographically. A value present on the Event wins over the same key
 * from the environment.
 */
export function buildResourceAttributes(input: {
  serviceName: string;
  event: Event;
  envAttributes: Record<string, string>;
}): OtlpAttribute[] {
  const { serviceName, event, envAttributes } = input;

  const attributes: OtlpAttribute[] = [
    { key: 'service.name', value: toAnyValue(serviceName) },
    { key: 'agent', value: toAnyValue(event.agent) },
    { key: 'session_id', value: toAnyValue(event.session_id) },
    { key: 'project', value: toAnyValue(event.project) },
  ];

  for (const key of OPTIONAL_RESOURCE_KEYS) {
    const value = event[key] ?? envAttributes[key];
    if (value !== undefined) {
      attributes.push({ key, value: toAnyValue(value) });
    }
  }

  const optionalResourceKeySet = new Set<string>(OPTIONAL_RESOURCE_KEYS);
  const remainingKeys = Object.keys(envAttributes)
    .filter((key) => !optionalResourceKeySet.has(key))
    .sort();

  for (const key of remainingKeys) {
    const value = envAttributes[key];
    if (value !== undefined) {
      attributes.push({ key, value: toAnyValue(value) });
    }
  }

  return attributes;
}

/**
 * Builds the per-record attribute array: `event.name`, then `kind`, then
 * every remaining Event key except the seven resource keys, sorted with
 * the default string sort.
 */
export function buildRecordAttributes(event: Event, eventName: string): OtlpAttribute[] {
  const attributes: OtlpAttribute[] = [
    { key: 'event.name', value: toAnyValue(eventName) },
    { key: 'kind', value: toAnyValue(event.kind) },
  ];

  const remainingEntries = Object.entries(event).filter(
    ([key]) => key !== 'kind' && !RESOURCE_ATTRIBUTE_KEY_SET.has(key),
  );
  const sortedKeys = remainingEntries.map(([key]) => key).sort();
  const valueByKey = new Map(remainingEntries);

  for (const key of sortedKeys) {
    const value = valueByKey.get(key);
    if (isAttributeValue(value)) {
      attributes.push({ key, value: toAnyValue(value) });
    }
  }

  return attributes;
}

function buildLogRecord(record: LogsPayloadRecord): OtlpLogRecord {
  const isApiError = record.event.kind === 'api_error';

  return {
    timeUnixNano: record.timeUnixNano,
    observedTimeUnixNano: record.timeUnixNano,
    severityNumber: isApiError ? 17 : 9,
    severityText: isApiError ? 'ERROR' : 'INFO',
    eventName: record.eventName,
    attributes: buildRecordAttributes(record.event, record.eventName),
  };
}

/**
 * Groups records that share an identical resource attribute array into one
 * `resourceLogs` entry, keyed by `JSON.stringify` of that array, and
 * produces one `scopeLogs` entry per group. `body` is never assigned on a
 * log record.
 */
export function buildLogsPayload(input: {
  serviceName: string;
  scopeName: string;
  scopeVersion: string;
  records: readonly LogsPayloadRecord[];
  envAttributes: Record<string, string>;
}): OtlpLogsPayload {
  const { serviceName, scopeName, scopeVersion, records, envAttributes } = input;

  const groups = new Map<string, { attributes: OtlpAttribute[]; logRecords: OtlpLogRecord[] }>();

  for (const record of records) {
    const attributes = buildResourceAttributes({ serviceName, event: record.event, envAttributes });
    const groupKey = JSON.stringify(attributes);
    const logRecord = buildLogRecord(record);

    const existingGroup = groups.get(groupKey);
    if (existingGroup === undefined) {
      groups.set(groupKey, { attributes, logRecords: [logRecord] });
    } else {
      existingGroup.logRecords.push(logRecord);
    }
  }

  const resourceLogs: OtlpResourceLogs[] = Array.from(groups.values()).map((group) => ({
    resource: { attributes: group.attributes },
    scopeLogs: [
      {
        scope: { name: scopeName, version: scopeVersion },
        logRecords: group.logRecords,
      },
    ],
  }));

  return { resourceLogs };
}
