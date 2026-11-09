/**
 * The watcher's pure core (`pnpm watch`, the Transcript-tailing feature).
 * No `node:*` import, no file system, no network, no clock read, no `git`
 * spawn: whole-file re-parse bookkeeping, line splitting, identity
 * extraction, and the injected-clock utility a watched Event's own time
 * travels through. `src/watch/cli.ts` is the thin, imperative shell that
 * reads files, spawns `git`, and sends OTLP. Label building is
 * `../session-label.js`'s `buildSessionLabel`, re-exported below so
 * callers that already import it from this module (`src/watch/cli.ts`,
 * `test/watch.test.ts`) keep working; `scripts/session-env.ts` imports
 * the same function from `../session-label.js` directly, so the two
 * label paths cannot drift apart.
 *
 * On the parser: `claudeCodeTranscriptParser.parse`
 * (`src/replayer/parsers/claude-code.ts`) joins a `tool_use` to its later
 * `tool_result` by `tool_use_id` in a single pass over whatever `lines` it
 * is given (that file's own PASS 2). Handing it only the lines one poll
 * newly appended — the module's earlier design — meant a `tool_use` and
 * its `tool_result` landing in two different polls could never meet
 * inside the same `parse` call, so the pair was reported as unpaired on
 * one poll and orphaned on the next, and the Event for it was never
 * built. `parseEventsSince` below instead re-parses the file's COMPLETE
 * lines on every poll that reads at all, so a pair always meets, and uses
 * `baselineSentCount` — how many of the deterministically-ordered Events
 * a previous poll already sent — to slice off only the Events that are
 * new. This still calls the parser exactly as it already is: no second
 * parser, no batch-accepting wrapper.
 */
import { z } from 'zod';
import { claudeCodeTranscriptParser } from '../replayer/parsers/claude-code.js';
import type { ParsedEvent, ParseResult } from '../replayer/parsers/index.js';
import { buildSessionLabel } from '../session-label.js';

export { buildSessionLabel };

/** One followed file's tailing position: the byte offset already consumed, and any held partial line. */
export interface TailState {
  readonly offset: number;
  readonly partial: string;
}

/** The lines `applyTailChunk` produced, plus the `TailState` to carry into the next poll. */
export interface TailChunkResult {
  readonly lines: readonly string[];
  readonly state: TailState;
}

/**
 * Splits `input.chunk` into complete lines, holding a trailing line with no
 * terminating `\n` back in `state.partial` until a later call supplies the
 * rest of it. `input.chunkBytes` is the exact byte count the caller read
 * for this chunk (not recomputed from `chunk.length`, which only agrees
 * with the byte count for single-byte characters): the next offset is
 * `input.offset + input.chunkBytes`. An empty `chunk` (nothing was read)
 * yields no lines and leaves `offset` and `partial` unchanged.
 */
export function applyTailChunk(input: {
  offset: number;
  partial: string;
  chunk: string;
  chunkBytes: number;
}): TailChunkResult {
  if (input.chunk === '') {
    return { lines: [], state: { offset: input.offset, partial: input.partial } };
  }

  const combined = input.partial + input.chunk;
  const parts = combined.split('\n');
  const partial = parts.pop() ?? '';

  return { lines: parts, state: { offset: input.offset + input.chunkBytes, partial } };
}

/**
 * The complete lines in `content`, exactly as `applyTailChunk` would split
 * them out of one chunk read from byte offset zero: a trailing fragment
 * with no terminating `\n` (a line still being written) is dropped rather
 * than handed to the parser as if it were complete. `content.length` is
 * passed as `chunkBytes` only to satisfy `applyTailChunk`'s input shape;
 * the resulting byte offset is never read back out, because a whole-file
 * re-read needs no carried byte position.
 */
export function linesOfWholeFile(content: string): readonly string[] {
  return applyTailChunk({ offset: 0, partial: '', chunk: content, chunkBytes: content.length })
    .lines;
}

/** One followed file's whole-file re-parse bookkeeping: the size last seen, and how many Events already sent from it. */
export interface FileTrackState {
  readonly size: number;
  readonly sentCount: number;
}

export const INITIAL_FILE_TRACK_STATE: FileTrackState = { size: 0, sentCount: 0 };

/** Whether a poll should re-read a file's whole content, and which Event count already covers it. */
export interface FilePollPlan {
  readonly shouldRead: boolean;
  readonly baselineSentCount: number;
}

/**
 * Decides whether a poll should re-read a file's whole content, from
 * `previous` (the `FileTrackState` stored at the end of the previous poll
 * that actually read the file) and the file's current `fileSize`. A size
 * equal to `previous.size` means nothing changed since that read:
 * `shouldRead` is `false`, so the whole-file re-parse this would otherwise
 * cost is skipped entirely — no reader call is ever made for an unchanged
 * file. A smaller `fileSize` means the file was truncated or rotated:
 * `previous.sentCount` no longer describes this file's content, so the
 * read is planned with a `baselineSentCount` of zero, as if the file were
 * newly discovered. Otherwise the file grew, and `previous.sentCount`
 * Events are already accounted for.
 */
export function planFilePoll(previous: FileTrackState, fileSize: number): FilePollPlan {
  if (fileSize === previous.size) {
    return { shouldRead: false, baselineSentCount: previous.sentCount };
  }
  const shrank = fileSize < previous.size;
  return { shouldRead: true, baselineSentCount: shrank ? 0 : previous.sentCount };
}

/**
 * The Events beyond `baselineSentCount` in a freshly parsed, deterministically
 * ordered `events` list — `events.slice(baselineSentCount)` — pulled out as
 * its own pure function so a test can state the "only the Events appended
 * since the previous poll" rule without re-deriving the slice index from a
 * `ParseResult` by hand.
 */
export function selectNewEvents(
  events: readonly ParsedEvent[],
  baselineSentCount: number,
): readonly ParsedEvent[] {
  return events.slice(baselineSentCount);
}

/** `parseEventsSince`'s parse, the Events new since `baselineSentCount`, and the `FileTrackState` to carry forward. */
export interface FileEventsSinceResult {
  readonly parse: ParseResult;
  readonly newEvents: readonly ParsedEvent[];
  readonly track: FileTrackState;
}

/**
 * Re-parses a file's complete `lines` with the unchanged
 * `claudeCodeTranscriptParser`, then keeps only the Events beyond
 * `baselineSentCount`. Because the parser sees every line the file holds
 * on every call, a `tool_use`/`tool_result` pair split across two polls
 * still meets inside the SAME `parse` call that completes it, fixing the
 * defect `tailAndParse`'s per-batch design had. `fileSize` is carried
 * through to `track.size` untouched, so the caller's next
 * `planFilePoll` call compares against the size this exact read saw, not
 * a value read at a different moment.
 *
 * Determinism this relies on: `claudeCodeTranscriptParser.parse` is a
 * pure function of `lines` (no `Date.now()`, no random, no Map iteration
 * order dependent on insertion order of anything but `lines` itself), and
 * its own PASS 3 sorts every candidate Event by `timeUnixNano` before
 * returning, so the same `lines` array always yields the same `events`
 * array, in the same order, on every call. Confirmed by parsing the real
 * Transcript corpus under `test/fixtures/transcripts/claude-code/` twice
 * in the same process and comparing the two `ParseResult.events` arrays
 * field by field: identical on every Fixture (see this change's own
 * report for the measured run).
 */
export function parseEventsSince(input: {
  lines: readonly string[];
  fileSize: number;
  project: string;
  baselineSentCount: number;
}): FileEventsSinceResult {
  const parse = claudeCodeTranscriptParser.parse({ lines: input.lines, project: input.project });
  const newEvents = selectNewEvents(parse.events, input.baselineSentCount);
  return { parse, newEvents, track: { size: input.fileSize, sentCount: parse.events.length } };
}

/** A settable nanosecond clock: `now` is read by `createOtlpSender`'s `emit`, `setNext` is called by this module's caller first. */
export interface EventClock {
  readonly now: () => bigint;
  readonly setNext: (nano: bigint) => void;
}

/**
 * Builds an `EventClock` whose `now` always returns whatever `setNext` last
 * stored, never a wall-clock reading. `src/events/otlp.ts`'s
 * `createOtlpSender` accepts a `now: () => bigint` option precisely so a
 * caller can replace its default monotonic wall clock; `cli.ts` passes this
 * `EventClock`'s `now` there, then calls `setNext` with one Event's own
 * `timeUnixNano` immediately before emitting that Event, so the record the
 * sender builds carries the Transcript's own time rather than the moment
 * the watcher happened to send it. `createOtlpSender` itself is read-only
 * in this change and is not modified: this clock uses the seam it already
 * exposes.
 */
export function createEventClock(): EventClock {
  let current = 0n;
  return {
    now: (): bigint => current,
    setNext: (nano: bigint): void => {
      current = nano;
    },
  };
}

/**
 * Converts one Event's own recorded `timeUnixNano` (a decimal nanosecond
 * epoch string) into the `bigint` `EventClock.setNext` needs.
 * `claudeCodeTranscriptParser` only ever builds a `ParsedEvent` from a line
 * whose own timestamp parsed cleanly (`lineTime` in
 * `src/replayer/parsers/claude-code.ts` contributes no Event at all
 * otherwise), so every `timeUnixNano` this module receives from a real
 * parse already is a valid digit string. A string `BigInt` cannot parse
 * falls back to `0n`, the Unix epoch: an Event stamped at the epoch is an
 * obviously wrong, immediately visible value on a dashboard, while
 * silently falling back to "now" would reintroduce the exact defect this
 * module exists to remove, and throwing would crash the watcher over one
 * line it did not itself validate.
 */
export function eventTimeNano(timeUnixNano: string): bigint {
  try {
    return BigInt(timeUnixNano);
  } catch {
    return 0n;
  }
}

/** The identity fields `extractIdentity` can read out of a Transcript's own lines. */
export interface TranscriptIdentity {
  readonly sessionId: string | undefined;
  readonly cwd: string | undefined;
  readonly firstEventIso: string | undefined;
}

/**
 * The fields this module reads off a raw Transcript line to resolve a
 * Session's identity. A separate schema from
 * `src/schema/transcript-claude-code.ts`'s `TranscriptLineSchema` on
 * purpose: that schema does not declare `cwd`, and it is a read-only file
 * in this change, so a `cwd` field already present at the top level of a
 * real Transcript line (confirmed by reading one real line's own keys,
 * never its content) needs its own minimal, equally permissive schema here.
 */
export const WatchIdentityLineSchema = z.looseObject({
  sessionId: z.string().min(1).optional(),
  cwd: z.string().min(1).optional(),
  timestamp: z.string().optional(),
});

/**
 * Extracts a Transcript's Session identifier, its `cwd`, and the earliest
 * parseable `timestamp` among `lines`, in one pass. The first `sessionId`
 * and the first `cwd` seen win, matching the first-seen convention
 * `claudeCodeTranscriptParser` already uses for `sessionId`. A line that is
 * not valid JSON, or that fails `WatchIdentityLineSchema`, contributes
 * nothing and is never thrown on.
 */
export function extractIdentity(lines: readonly string[]): TranscriptIdentity {
  let sessionId: string | undefined;
  let cwd: string | undefined;
  let firstEventIso: string | undefined;

  for (const rawLine of lines) {
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(rawLine);
    } catch {
      continue;
    }

    const result = WatchIdentityLineSchema.safeParse(parsedJson);
    if (!result.success) {
      continue;
    }

    if (sessionId === undefined && result.data.sessionId !== undefined) {
      sessionId = result.data.sessionId;
    }
    if (cwd === undefined && result.data.cwd !== undefined) {
      cwd = result.data.cwd;
    }
    if (result.data.timestamp !== undefined) {
      const candidateMs = Date.parse(result.data.timestamp);
      const currentMs = firstEventIso === undefined ? undefined : Date.parse(firstEventIso);
      if (!Number.isNaN(candidateMs) && (currentMs === undefined || candidateMs < currentMs)) {
        firstEventIso = result.data.timestamp;
      }
    }
  }

  return { sessionId, cwd, firstEventIso };
}

/** The one Event name `cli.ts` sends under, per `Kind` this parser can ever produce. */
export const WATCH_MODEL_CALL = 'watch.model_call';
export const WATCH_TOOL_CALL = 'watch.tool_call';
export const WATCH_PROMPT = 'watch.prompt';

/**
 * Maps a parsed Event's `Kind` to the Event name `cli.ts` sends it under.
 * `claudeCodeTranscriptParser` only ever produces `model_call`, `tool_call`
 * or `prompt` (its `PendingPayload` union has no fourth member), so this
 * function is exhaustive over exactly those three without a `default` case.
 */
export function eventNameFor(kind: 'model_call' | 'tool_call' | 'prompt'): string {
  switch (kind) {
    case 'model_call':
      return WATCH_MODEL_CALL;
    case 'tool_call':
      return WATCH_TOOL_CALL;
    case 'prompt':
      return WATCH_PROMPT;
  }
}

function sanitizeAttributeValue(value: string): string {
  return value.replace(/[,=]/g, ' ');
}

/**
 * Renders the `OTEL_RESOURCE_ATTRIBUTES` string `cli.ts` feeds to
 * `createOtlpSender`'s `env`, the same `key=value,...` form
 * `src/events/otlp-payload.ts`'s `parseResourceAttributes` reads back. A
 * key whose value is `undefined` or `''` is omitted entirely, so a Session
 * with no resolvable `branch` sends a string with no `branch` entry rather
 * than one with an empty value.
 */
export function encodeResourceAttributes(attrs: Record<string, string | undefined>): string {
  const entries = Object.entries(attrs).filter(
    (entry): entry is [string, string] => entry[1] !== undefined && entry[1] !== '',
  );
  return entries.map(([key, value]) => `${key}=${sanitizeAttributeValue(value)}`).join(',');
}
