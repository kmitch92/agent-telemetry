import { z } from 'zod';
import { EventSchema, KindSchema } from '../schema/index.js';
import type { Event } from '../schema/index.js';
import { AnyValueSchema, fromAnyValue } from './otlp-payload.js';

/**
 * Pure line classifier. No import from `node:*`, no file or network
 * access: parsing and classifying one already-read line only.
 */

/** Used as the `agent` of an `unknown_kind` outcome when the line carries none. */
export const UNKNOWN_AGENT_KEY = '(unset)';

/** One Event plus the two facts an OTLP log record alone can supply. */
export interface EventRecord {
  event: Event;
  eventName: string | undefined;
  timeUnixNano: string | undefined;
}

/**
 * The result of classifying one line. One line can yield many outcomes,
 * because one OTLP envelope can carry many log records.
 */
export type LineOutcome =
  | { outcome: 'event'; record: EventRecord }
  | { outcome: 'unknown_kind'; agent: string }
  | { outcome: 'malformed'; reason: string };

/**
 * Tolerant attribute shape for a foreign OTLP producer. `value` stays
 * `unknown` here; `decodeAttributes` validates it against `AnyValueSchema`
 * one key at a time, so a single bad attribute fails only its own record.
 */
const TolerantAttributeSchema = z.object({
  key: z.string(),
  value: z.unknown(),
});

type TolerantAttribute = z.infer<typeof TolerantAttributeSchema>;

/**
 * Tolerant log record shape. Unlike `OtlpLogRecordSchema`, every field is
 * optional, because a foreign producer may omit `severityText`, `eventName`,
 * or `observedTimeUnixNano`.
 */
const TolerantLogRecordSchema = z.object({
  timeUnixNano: z.string().optional(),
  eventName: z.string().optional(),
  attributes: z.array(TolerantAttributeSchema).optional(),
});

const TolerantScopeLogsSchema = z.object({
  logRecords: z.array(TolerantLogRecordSchema).optional(),
});

const TolerantResourceLogsSchema = z.object({
  resource: z
    .object({
      attributes: z.array(TolerantAttributeSchema).optional(),
    })
    .optional(),
  scopeLogs: z.array(TolerantScopeLogsSchema).optional(),
});

/** Tolerant envelope shape, used only to tell an OTLP envelope from a flat line. */
const TolerantEnvelopeSchema = z.object({
  resourceLogs: z.array(TolerantResourceLogsSchema),
});

type DecodedAttributesResult =
  { ok: true; value: Record<string, string | number | boolean> } | { ok: false; reason: string };

/**
 * Decodes a list of OTLP attributes into a plain object. Fails the whole
 * list, with a reason naming the offending key, on the first attribute
 * whose value does not match `AnyValueSchema` or that `fromAnyValue` cannot
 * turn into a concrete value.
 */
function decodeAttributes(attributes: readonly TolerantAttribute[]): DecodedAttributesResult {
  const value: Record<string, string | number | boolean> = {};

  for (const attribute of attributes) {
    const parsedValue = AnyValueSchema.safeParse(attribute.value);
    if (!parsedValue.success) {
      return { ok: false, reason: `attribute "${attribute.key}" is not a valid AnyValue` };
    }

    const decoded = fromAnyValue(parsedValue.data);
    if (decoded === undefined) {
      return { ok: false, reason: `attribute "${attribute.key}" decoded to no value` };
    }

    value[attribute.key] = decoded;
  }

  return { ok: true, value };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Classifies one flat candidate object: a line that was never an OTLP
 * envelope, or one log record already flattened out of one. `context`
 * carries the facts only the caller knows: the OTLP record's own time and
 * event name, both `undefined` for a plain flat line.
 */
function classifyCandidate(
  candidate: Record<string, unknown>,
  context: { eventName: string | undefined; timeUnixNano: string | undefined },
): LineOutcome {
  const kindValue = candidate['kind'];
  if (typeof kindValue !== 'string' || !KindSchema.safeParse(kindValue).success) {
    const agentValue = candidate['agent'];
    const agent =
      typeof agentValue === 'string' && agentValue !== '' ? agentValue : UNKNOWN_AGENT_KEY;
    return { outcome: 'unknown_kind', agent };
  }

  const parsed = EventSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      outcome: 'malformed',
      reason: parsed.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; '),
    };
  }

  return {
    outcome: 'event',
    record: {
      event: parsed.data,
      eventName: context.eventName,
      timeUnixNano: context.timeUnixNano,
    },
  };
}

/**
 * Validates one parsed line as a tolerant OTLP envelope, then flattens
 * every log record under it into one flat candidate per record: the
 * decoded resource attributes of its parent `resourceLogs` entry spread
 * first, then the decoded record attributes, so a record attribute wins
 * on a key collision.
 */
function flattenEnvelope(parsed: Record<string, unknown>): LineOutcome[] {
  const parsedEnvelope = TolerantEnvelopeSchema.safeParse(parsed);
  if (!parsedEnvelope.success) {
    return [
      {
        outcome: 'malformed',
        reason: parsedEnvelope.error.issues
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; '),
      },
    ];
  }

  const outcomes: LineOutcome[] = [];

  for (const resourceLogsEntry of parsedEnvelope.data.resourceLogs) {
    const decodedResource = decodeAttributes(resourceLogsEntry.resource?.attributes ?? []);

    for (const scopeLogsEntry of resourceLogsEntry.scopeLogs ?? []) {
      for (const logRecord of scopeLogsEntry.logRecords ?? []) {
        if (!decodedResource.ok) {
          outcomes.push({ outcome: 'malformed', reason: decodedResource.reason });
          continue;
        }

        const decodedRecord = decodeAttributes(logRecord.attributes ?? []);
        if (!decodedRecord.ok) {
          outcomes.push({ outcome: 'malformed', reason: decodedRecord.reason });
          continue;
        }

        const candidate: Record<string, unknown> = {
          ...decodedResource.value,
          ...decodedRecord.value,
        };

        const nameAttribute = candidate['event.name'];
        const eventName =
          logRecord.eventName ?? (typeof nameAttribute === 'string' ? nameAttribute : undefined);

        outcomes.push(
          classifyCandidate(candidate, { eventName, timeUnixNano: logRecord.timeUnixNano }),
        );
      }
    }
  }

  return outcomes;
}

/**
 * Classifies one already-read line, returning an array because one OTLP
 * line can carry many log records. An empty or whitespace-only line yields
 * no outcome at all.
 */
export function classifyLine(line: string): LineOutcome[] {
  const trimmed = line.trim();
  if (trimmed === '') {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown parse failure';
    return [{ outcome: 'malformed', reason: `invalid JSON: ${reason}` }];
  }

  if (!isPlainObject(parsed)) {
    return [{ outcome: 'malformed', reason: 'line is not a JSON object' }];
  }

  if ('resourceLogs' in parsed) {
    return flattenEnvelope(parsed);
  }

  return [classifyCandidate(parsed, { eventName: undefined, timeUnixNano: undefined })];
}
