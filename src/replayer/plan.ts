import type { Event, Kind, RunEndEvent } from '../schema/events.js';
import { classifyLine } from '../events/line.js';
import {
  MCP_SERVER_CALL,
  REPLAY_API_ERROR,
  REPLAY_MODEL_CALL,
  REPLAY_PROMPT,
  REPLAY_TOOL_CALL,
  RUNNER_RUN_END,
  RUNNER_RUN_START,
} from '../events/event-names.js';
import type { ParsedEvent, TranscriptParser } from './parsers/index.js';

/**
 * The Replayer's own planning module (the `replayer` ticket, SPEC.md:594).
 * This module is part of the functional core: no `node:*` import, no file
 * system access, no network access. Every caller reads the Fixtures and the
 * Collector configuration itself and passes the text in here. `plan.ts`
 * turns that text into the plain data a thin, imperative edge module later
 * writes out as OTLP, or compares against what the Stack actually received.
 */

/** The `task` and `variant` stamped onto every Event this module plans. */
export const REPLAY_LABEL = 'replay';

/**
 * The `run_id` prefix stamped onto every synthetic Run this module plans.
 * SPEC.md:57 makes a real `run_id` a ULID, so a `replay-` prefix is never a
 * valid ULID: a synthetic Run can never be mistaken for a real one in the
 * Results table (tickets.yaml:503-504).
 */
export const REPLAY_RUN_ID_PREFIX = 'replay-';

/** One Event this plan replays, paired with the Event name it replays it under. */
export interface PlannedEvent {
  event: Event;
  eventName: string;
}

/** One Transcript's worth of planned Events, grouped under one synthetic Run. */
export interface ReplayGroup {
  agent: string;
  sessionId: string;
  runId: string;
  events: PlannedEvent[];
}

/** Every group `buildFixturePlan` produced, plus the total Event count across all of them. */
export interface ReplayPlan {
  groups: ReplayGroup[];
  totalEvents: number;
}

/** One Transcript's file stem and the lines read from it, read by the caller. */
export interface FixtureTranscript {
  stem: string;
  lines: readonly string[];
}

/** A total map from `Kind` to the Event name `buildFixturePlan` replays that Kind under. */
const EVENT_NAME_BY_KIND: Record<Kind, string> = {
  model_call: REPLAY_MODEL_CALL,
  tool_call: REPLAY_TOOL_CALL,
  prompt: REPLAY_PROMPT,
  api_error: REPLAY_API_ERROR,
  mcp_server_call: MCP_SERVER_CALL,
  run_start: RUNNER_RUN_START,
  run_end: RUNNER_RUN_END,
};

/**
 * Stamps `run_id`, `task` and `variant` onto `event`, leaving every other
 * field unchanged. A plain typed object spread compiles here: TypeScript
 * keeps the discriminant literal (`kind`) through the spread because every
 * member of the `Event` union already declares `run_id`, `task` and
 * `variant` as optional fields of the same type, so no `EventSchema.parse`
 * fallback and no `as` cast is needed.
 */
function stampEvent(event: Event, runId: string): Event {
  return { ...event, run_id: runId, task: REPLAY_LABEL, variant: REPLAY_LABEL };
}

/** The count of a group's own parsed Events whose `kind` is `kind`. */
function countKind(events: readonly ParsedEvent[], kind: Kind): number {
  return events.filter((parsed) => parsed.event.kind === kind).length;
}

/** The sum of one numeric, optional `model_call` field across a group's own parsed Events. */
function sumModelCallField(
  events: readonly ParsedEvent[],
  field: 'input_tokens' | 'output_tokens' | 'cache_read_tokens',
): number {
  let total = 0;
  for (const parsed of events) {
    if (parsed.event.kind === 'model_call') {
      total += parsed.event[field] ?? 0;
    }
  }
  return total;
}

/**
 * The wall-clock span of a group's own parsed Events, in whole milliseconds,
 * computed with `BigInt` arithmetic over the first and last `timeUnixNano`.
 * Zero when the group has fewer than two parsed Events. A negative result
 * clamps to zero, because `wall_ms` is a non-negative integer in the schema
 * (src/schema/events.ts:126): an out-of-order Transcript must never produce
 * a negative duration.
 */
function wallMs(events: readonly ParsedEvent[]): number {
  if (events.length < 2) {
    return 0;
  }

  const first = events[0];
  const last = events[events.length - 1];
  if (first === undefined || last === undefined) {
    return 0;
  }

  const diffNano = BigInt(last.timeUnixNano) - BigInt(first.timeUnixNano);
  const diffMs = diffNano / 1_000_000n;
  return diffMs < 0n ? 0 : Number(diffMs);
}

/** Builds the one synthetic `run_end` Event appended last to every group. */
function buildRunEndEvent(input: {
  agent: string;
  sessionId: string;
  project: string;
  runId: string;
  events: readonly ParsedEvent[];
}): RunEndEvent {
  const { agent, sessionId, project, runId, events } = input;

  return {
    kind: 'run_end',
    agent,
    session_id: sessionId,
    project,
    run_id: runId,
    task: REPLAY_LABEL,
    variant: REPLAY_LABEL,
    rep: 0,
    turns: countKind(events, 'model_call'),
    tool_calls: countKind(events, 'tool_call'),
    // Counts the mcp_server_call Kind literally. A tool_call whose
    // tool_type is 'mcp' is a different Kind, and conflating the two would
    // overstate a figure no Transcript measures.
    mcp_server_calls: countKind(events, 'mcp_server_call'),
    input_tokens: sumModelCallField(events, 'input_tokens'),
    output_tokens: sumModelCallField(events, 'output_tokens'),
    cache_read_tokens: sumModelCallField(events, 'cache_read_tokens'),
    wall_ms: wallMs(events),
    // A replay runs no Checker, so pass, timed_out and expected_tools_hit
    // are never measured. CLAUDE.md's hard prohibition 5 forbids
    // fabricating a value to make a dashboard panel pass, so false is the
    // honest reading here, and the pass-rate panel reads zero for every
    // synthetic Run. exit_code is omitted entirely for the same reason.
    pass: false,
    timed_out: false,
    expected_tools_hit: false,
  };
}

/**
 * Builds one `ReplayGroup` per `FixtureTranscript`, in input order. Each
 * group's `runId` is `REPLAY_RUN_ID_PREFIX` plus the Transcript's own stem;
 * its `sessionId` is the parser's own `sessionId`, falling back to the stem
 * when the parse produced none (for example an all-blank Transcript). Every
 * parsed Event is stamped with the group's `runId`, `task` and `variant` and
 * named by its `Kind`; one synthetic `run_end` Event, named `RUNNER_RUN_END`
 * and computed only from that group's own parsed Events, is appended last.
 */
export function buildFixturePlan(input: {
  transcripts: readonly FixtureTranscript[];
  project: string;
  parser: TranscriptParser;
}): ReplayPlan {
  const groups: ReplayGroup[] = [];

  for (const transcript of input.transcripts) {
    const result = input.parser.parse({ lines: transcript.lines, project: input.project });
    const sessionId = result.sessionId ?? transcript.stem;
    const runId = `${REPLAY_RUN_ID_PREFIX}${transcript.stem}`;

    const plannedEvents: PlannedEvent[] = result.events.map((parsed) => ({
      event: stampEvent(parsed.event, runId),
      eventName: EVENT_NAME_BY_KIND[parsed.event.kind],
    }));

    plannedEvents.push({
      event: buildRunEndEvent({
        agent: input.parser.agent,
        sessionId,
        project: input.project,
        runId,
        events: result.events,
      }),
      eventName: RUNNER_RUN_END,
    });

    groups.push({ agent: input.parser.agent, sessionId, runId, events: plannedEvents });
  }

  const totalEvents = groups.reduce((total, group) => total + group.events.length, 0);

  return { groups, totalEvents };
}

/** The result of rewriting the lines of one recorded Event Fixture file. */
export interface EventsReplayPlan {
  lines: string[];
  records: number;
  expectedEvents: number;
  sessionIds: Set<string>;
}

/** True for a value that is a non-null, non-array object, never a primitive or `null`. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Returns `parent[key]` as a plain object, creating and storing one when it is absent. */
function ensurePlainObjectField(
  parent: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const existing = parent[key];
  if (isPlainObject(existing)) {
    return existing;
  }

  const created: Record<string, unknown> = {};
  parent[key] = created;
  return created;
}

/** Returns `parent[key]` as an array, creating and storing one when it is absent. */
function ensureArrayField(parent: Record<string, unknown>, key: string): unknown[] {
  const existing = parent[key];
  if (Array.isArray(existing)) {
    return existing;
  }

  const created: unknown[] = [];
  parent[key] = created;
  return created;
}

/**
 * Pushes a `project_path` resource attribute onto every `resourceLogs` entry
 * of `parsed`, mutating it in place. The recorded Fixture carries no
 * `project_path`, so without one the Collector derives no `project` and
 * every record then fails `EventSchema` for a missing `project`. A live
 * Agent does send it through `OTEL_RESOURCE_ATTRIBUTES`
 * (scripts/record-live.ts:174-189), and the Normaliser integration test
 * injects it the same way (test/normaliser.integration.test.ts:82-104).
 * Nothing else about `parsed` is changed.
 */
function injectProjectPathAttribute(parsed: Record<string, unknown>, projectPath: string): void {
  const resourceLogs = parsed['resourceLogs'];
  if (!Array.isArray(resourceLogs)) {
    return;
  }

  for (const entry of resourceLogs) {
    if (!isPlainObject(entry)) {
      continue;
    }

    const resource = ensurePlainObjectField(entry, 'resource');
    const attributes = ensureArrayField(resource, 'attributes');
    attributes.push({ key: 'project_path', value: { stringValue: projectPath } });
  }
}

/**
 * Walks `parsed` down to every `resourceLogs[].scopeLogs[].logRecords[]`
 * entry, using an explicit guard at each level: a level whose shape does
 * not match contributes no log record, the same tolerant style
 * `isPlainObject` here mirrors from src/events/line.ts:100-102.
 */
function collectLogRecords(parsed: Record<string, unknown>): Record<string, unknown>[] {
  const collected: Record<string, unknown>[] = [];
  const resourceLogs = parsed['resourceLogs'];
  if (!Array.isArray(resourceLogs)) {
    return collected;
  }

  for (const resourceLogsEntry of resourceLogs) {
    if (!isPlainObject(resourceLogsEntry)) {
      continue;
    }

    const scopeLogs = resourceLogsEntry['scopeLogs'];
    if (!Array.isArray(scopeLogs)) {
      continue;
    }

    for (const scopeLogsEntry of scopeLogs) {
      if (!isPlainObject(scopeLogsEntry)) {
        continue;
      }

      const logRecords = scopeLogsEntry['logRecords'];
      if (!Array.isArray(logRecords)) {
        continue;
      }

      for (const logRecord of logRecords) {
        if (isPlainObject(logRecord)) {
          collected.push(logRecord);
        }
      }
    }
  }

  return collected;
}

/** Reads one attribute's `value.stringValue` out of a log record's `attributes` array. */
function stringAttributeOf(logRecord: Record<string, unknown>, key: string): string | undefined {
  const attributes = logRecord['attributes'];
  if (!Array.isArray(attributes)) {
    return undefined;
  }

  for (const attribute of attributes) {
    if (!isPlainObject(attribute) || attribute['key'] !== key) {
      continue;
    }

    const value = attribute['value'];
    if (!isPlainObject(value)) {
      continue;
    }

    const stringValue = value['stringValue'];
    if (typeof stringValue === 'string') {
      return stringValue;
    }
  }

  return undefined;
}

/**
 * Resolves one log record's Agent event name the way
 * src/events/line.ts:185-187 does: the record's own `eventName` string
 * field when present, otherwise its `event.name` attribute's
 * `value.stringValue`.
 */
function resolveEventName(logRecord: Record<string, unknown>): string | undefined {
  const ownName = logRecord['eventName'];
  if (typeof ownName === 'string') {
    return ownName;
  }

  return stringAttributeOf(logRecord, 'event.name');
}

/**
 * Rewrites every line of one recorded Event Fixture, injecting the one
 * `project_path` resource attribute every line needs to pass `EventSchema`
 * downstream, and counts what the Fixture carries along the way. A blank
 * line produces no output line and no counts. A line that is not valid JSON,
 * or whose parsed shape does not carry a `resourceLogs` array, passes
 * through unchanged and contributes no counts: this function's only job is
 * to inject one attribute into a well-formed OTLP envelope, never to repair
 * or drop a line it does not understand. The envelope is walked with
 * explicit type guards, never rebuilt through a Zod schema, because a Zod
 * object schema strips every key it does not declare and this function must
 * change nothing except the one injected attribute.
 */
export function buildEventsPlan(input: {
  lines: readonly string[];
  projectPath: string;
  mapping: ReadonlyMap<string, Kind>;
}): EventsReplayPlan {
  const lines: string[] = [];
  let records = 0;
  let expectedEvents = 0;
  const sessionIds = new Set<string>();

  for (const rawLine of input.lines) {
    if (rawLine.trim() === '') {
      continue;
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(rawLine);
    } catch {
      lines.push(rawLine);
      continue;
    }

    if (!isPlainObject(parsedJson)) {
      lines.push(rawLine);
      continue;
    }

    if (!Array.isArray(parsedJson['resourceLogs'])) {
      lines.push(rawLine);
      continue;
    }

    injectProjectPathAttribute(parsedJson, input.projectPath);

    for (const logRecord of collectLogRecords(parsedJson)) {
      records += 1;

      const eventName = resolveEventName(logRecord);
      if (eventName !== undefined && input.mapping.has(eventName)) {
        expectedEvents += 1;
      }

      const sessionId = stringAttributeOf(logRecord, 'session.id');
      if (sessionId !== undefined) {
        sessionIds.add(sessionId);
      }
    }

    lines.push(JSON.stringify(parsedJson));
  }

  return { lines, records, expectedEvents, sessionIds };
}

/** How many of a replayed line set's outcomes landed as an Event, as malformed, or as an unknown Kind. */
export interface ReceivedCounts {
  events: number;
  malformed: number;
  unknownKind: number;
}

/**
 * Folds `classifyLine`'s outcomes over `lines`, counting an `'event'`
 * outcome only when its Event's `session_id` is a member of `sessionIds`:
 * another live Agent Session writing to the same `data/events.jsonl` would
 * otherwise inflate the count. `malformed` and `unknownKind` outcomes are
 * counted unfiltered, since they carry no Session of their own to filter by.
 */
export function countReceived(
  lines: readonly string[],
  sessionIds: ReadonlySet<string>,
): ReceivedCounts {
  let events = 0;
  let malformed = 0;
  let unknownKind = 0;

  for (const line of lines) {
    for (const outcome of classifyLine(line)) {
      if (outcome.outcome === 'event') {
        if (sessionIds.has(outcome.record.event.session_id)) {
          events += 1;
        }
      } else if (outcome.outcome === 'malformed') {
        malformed += 1;
      } else {
        unknownKind += 1;
      }
    }
  }

  return { events, malformed, unknownKind };
}
