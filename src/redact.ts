/**
 * Pure redactor (SPEC.md:590). No import from a Node built-in module, no
 * file or network access: deciding what to keep, hash, or blank out, and
 * walking a JSON
 * value to do it, only. The hash function itself lives in `src/hash.ts` and
 * is taken here by injection, the same pattern `waitForSettle` uses for
 * `now` and `sleep`.
 */

/** The hash function this module never imports on its own. */
export interface RedactOptions {
  hashId: (value: string) => string;
}

/** What happens to a string found under a given name context. */
export type Policy = 'keep' | 'hash' | 'redact';

/**
 * Field names whose string value is structural, not content, and is kept
 * verbatim. Holds two groups: the names SPEC.md mandates, and the
 * structural attribute keys one live Claude Code 2.1.270 recording showed.
 */
export const KEEP_NAMES: ReadonlySet<string> = new Set([
  'event.name',
  'eventName',
  'kind',
  'agent',
  'project',
  'task',
  'variant',
  'run_id',
  'rep',
  'service.name',
  'scope',
  'name',
  'version',
  'severityText',
  'severityNumber',
  'timeUnixNano',
  'observedTimeUnixNano',
  'timestamp',
  'type',
  'role',
  'model',
  'stop_reason',
  'stop_sequence',
  'tool_use_id',
  'id',
  'uuid',
  'parentUuid',
  'request_id',
  'is_error',
  'success',
  'tool_type',
  'mcp_server',
  'error_type',
  'status_code',
  // Observed in a live Claude Code 2.1.270 recording.
  'event.timestamp',
  'tool_name',
  'tool_source',
  'decision',
  'source',
  'status',
  'transport_type',
  'server_scope',
  'hook_event',
  'hook_name',
  'hook_source',
  'hook_type',
  'query_source',
  'effort',
  'speed',
  'safe_mode',
  'managed_only',
  'terminal.type',
  'service.version',
  'os.type',
  'os.version',
  'host.arch',
]);

/** Matches a session or conversation identifier spelling, whatever the case. */
const SESSION_NAME_PATTERN = /session|conversation/i;
/** Matches the "id" or "uuid" half of a session-identifier spelling. */
const ID_NAME_PATTERN = /id|uuid/i;

/**
 * Decides the policy for a name context. Deny by default: an unrecognised
 * or missing name redacts. The session/conversation-id rule is checked
 * first, so `session_id`, `session.id` and `sessionId` all hash without
 * this module needing to know every spelling in advance.
 */
export function policyFor(name: string | undefined): Policy {
  if (name !== undefined && SESSION_NAME_PATTERN.test(name) && ID_NAME_PATTERN.test(name)) {
    return 'hash';
  }
  if (name !== undefined && KEEP_NAMES.has(name)) {
    return 'keep';
  }
  return 'redact';
}

/** A same-length placeholder: length preserving, nothing else preserved. */
export function placeholder(length: number): string {
  if (!Number.isFinite(length) || length < 0) {
    return '';
  }
  return 'x'.repeat(length);
}

/**
 * Property names OTLP JSON uses to wrap a value without naming it. The
 * attribute name lives in a sibling `key` field instead, so a child under
 * one of these keeps its parent's name context rather than taking its own.
 */
const TRANSPARENT_NAMES = new Set(['value', 'stringValue', 'arrayValue', 'kvlistValue', 'values']);

/**
 * OTLP JSON encodes a 64-bit integer, a double, or a bool as the direct
 * value of one of these three keys. That value is always kept, whatever
 * the enclosing name context says, because it is a number or a boolean on
 * the wire, never text.
 */
const NUMERIC_WRAPPER_NAMES = new Set(['intValue', 'doubleValue', 'boolValue']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The recursive walk `redactJson` and `collectNamedStrings` both build on.
 * `name` is the name context in force for `value`, `undefined` at the root.
 */
function walkJson(
  value: unknown,
  name: string | undefined,
  hashId: (value: string) => string,
): unknown {
  if (Array.isArray(value)) {
    return value.map((element) => walkJson(element, name, hashId));
  }

  if (isRecord(value)) {
    const keyValue = value['key'];
    if (typeof keyValue === 'string' && 'value' in value) {
      return { ...value, value: walkJson(value['value'], keyValue, hashId) };
    }

    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      const child = value[key];
      if (NUMERIC_WRAPPER_NAMES.has(key)) {
        result[key] = child;
        continue;
      }
      const childName = TRANSPARENT_NAMES.has(key) ? name : key;
      result[key] = walkJson(child, childName, hashId);
    }
    return result;
  }

  if (typeof value === 'string') {
    const policy = policyFor(name);
    if (policy === 'keep') {
      return value;
    }
    if (policy === 'hash') {
      return hashId(value);
    }
    return placeholder(value.length);
  }

  return value;
}

/**
 * Builds a new value with every string judged by `policyFor` on its name
 * context, never mutating `value`. See `walkJson` for the walk itself.
 */
export function redactJson(value: unknown, options: RedactOptions): unknown {
  return walkJson(value, undefined, options.hashId);
}

/**
 * Parses `line` as JSON and redacts it with `redactJson`. A parse failure
 * returns `ok: false` with the parser's own message as `reason`; it never
 * throws. The returned line carries no trailing newline.
 */
export function redactLine(
  line: string,
  options: RedactOptions,
): { ok: true; line: string } | { ok: false; reason: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown parse failure';
    return { ok: false, reason };
  }

  return { ok: true, line: JSON.stringify(redactJson(parsed, options)) };
}

/**
 * Walks `value` with the same name-context rules `redactJson` uses,
 * including the transparent-name set, and collects every string at least
 * `minLength` long, paired with the name context in force for it. A
 * numeric-wrapper string is NOT collected, because `redactJson` keeps it,
 * and the two walks must agree so a caller can pair a sample with the
 * policy that will actually apply to it.
 */
export function collectNamedStrings(
  value: unknown,
  minLength: number,
): { name: string | undefined; value: string }[] {
  const results: { name: string | undefined; value: string }[] = [];
  collectStrings(value, undefined, minLength, results);
  return results;
}

function collectStrings(
  value: unknown,
  name: string | undefined,
  minLength: number,
  results: { name: string | undefined; value: string }[],
): void {
  if (Array.isArray(value)) {
    for (const element of value) {
      collectStrings(element, name, minLength, results);
    }
    return;
  }

  if (isRecord(value)) {
    const keyValue = value['key'];
    if (typeof keyValue === 'string' && 'value' in value) {
      collectStrings(value['value'], keyValue, minLength, results);
      return;
    }

    for (const key of Object.keys(value)) {
      if (NUMERIC_WRAPPER_NAMES.has(key)) {
        continue;
      }
      const childName = TRANSPARENT_NAMES.has(key) ? name : key;
      collectStrings(value[key], childName, minLength, results);
    }
    return;
  }

  if (typeof value === 'string' && value.length >= minLength) {
    results.push({ name, value });
  }
}
