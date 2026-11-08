import type { AnyValue } from '../events/otlp-payload.js';
import { ConformOtlpLineSchema } from '../schema/conform.js';
import type { ConformOtlpAttribute } from '../schema/conform.js';

/**
 * Parses conformance-checker input lines into flat records, independent of
 * `readEventsFile` (`src/events/read.ts:66`).
 * That function validates each line through `EventSchema`, which keeps only
 * the keys this repository's own schemas name and drops every other
 * attribute. The checker must see every attribute an arbitrary MCP (Model
 * Context Protocol) server emitted, because the 2048-byte rule and the
 * no-request-text rule apply to all of them, not only to the attributes
 * this repository's own writer happens to produce.
 */

/** One flattened log record, independent of which resourceLogs or scopeLogs entry it came from. */
export interface ConformRecord {
  eventName: string | undefined;
  attributes: Record<string, AnyValue>;
  resource: Record<string, AnyValue>;
  timeUnixNano: string;
}

function foldAttributes(attributes: readonly ConformOtlpAttribute[]): Record<string, AnyValue> {
  const result: Record<string, AnyValue> = {};
  for (const attribute of attributes) {
    result[attribute.key] = attribute.value;
  }
  return result;
}

/**
 * True when `value` is a JSON object carrying `key` as a top-level own
 * property, regardless of that property's value.
 */
function hasTopLevelKey(value: unknown, key: string): boolean {
  return typeof value === 'object' && value !== null && key in value;
}

/**
 * The Collector's file exporter writes the metrics signal and the logs
 * signal to the same file (`compose/collector/config.yaml:123-128`). A line
 * whose only top-level key is `resourceMetrics` or `resourceSpans` is a
 * well-formed envelope of a different OTLP signal, not a malformed log line,
 * so `parseConformLines` skips it rather than counting it as malformed.
 */
function isOtherOtlpSignal(value: unknown): boolean {
  return (
    !hasTopLevelKey(value, 'resourceLogs') &&
    (hasTopLevelKey(value, 'resourceMetrics') || hasTopLevelKey(value, 'resourceSpans'))
  );
}

/**
 * Parses each of `lines` as one whole OTLP (OpenTelemetry Protocol)
 * envelope, flattening every `resourceLogs` / `scopeLogs` / `logRecords`
 * entry into one `ConformRecord` per log record, in document order. A blank
 * or whitespace-only line is skipped and does not count as malformed. A
 * line that is not valid JSON, or that fails `ConformOtlpLineSchema`,
 * increments `malformed` and yields no record.
 */
export function parseConformLines(lines: readonly string[]): {
  records: ConformRecord[];
  malformed: number;
} {
  const records: ConformRecord[] = [];
  let malformed = 0;

  for (const line of lines) {
    if (line.trim() === '') {
      continue;
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(line);
    } catch {
      malformed += 1;
      continue;
    }

    if (isOtherOtlpSignal(parsedJson)) {
      continue;
    }

    const parsed = ConformOtlpLineSchema.safeParse(parsedJson);
    if (!parsed.success) {
      malformed += 1;
      continue;
    }

    for (const resourceLogs of parsed.data.resourceLogs) {
      const resource = foldAttributes(resourceLogs.resource.attributes);

      for (const scopeLogs of resourceLogs.scopeLogs) {
        for (const logRecord of scopeLogs.logRecords) {
          records.push({
            eventName: logRecord.eventName,
            attributes: foldAttributes(logRecord.attributes),
            resource,
            timeUnixNano: logRecord.timeUnixNano,
          });
        }
      }
    }
  }

  return { records, malformed };
}
