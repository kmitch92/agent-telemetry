import { execFileSync } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createOtlpSender } from '../events/otlp.js';
import type { OtlpSender } from '../events/otlp.js';
import { sha256Hex } from '../hash.js';
import { parseSince } from '../sessions/index.js';
import { projectFromProjectPath } from '../replayer/parsers/index.js';
import {
  buildSessionLabel,
  createEventClock,
  encodeResourceAttributes,
  eventNameFor,
  eventTimeNano,
  extractIdentity,
  linesOfWholeFile,
  parseEventsSince,
  planFilePoll,
  INITIAL_FILE_TRACK_STATE,
} from './index.js';
import type { EventClock, FileTrackState } from './index.js';

/**
 * `pnpm watch`: follows every Claude Code Transcript the operator's own
 * machine is writing right now, without an `OTEL_*` environment variable
 * and without restarting the Session that is already running. This is the
 * imperative shell: every file read, every `git` spawn, the clock, and the
 * OTLP `fetch` live here; the whole-file re-parse bookkeeping, the line
 * splitting, the identity extraction and the label building all live in
 * `./index.ts`, the pure core this module only calls.
 *
 * Every followed file is re-read WHOLE on a poll that detects growth
 * (`decideAndRead`, `planFilePoll` in `./index.ts`), never tailed in
 * isolated batches: that is what lets a `tool_use`/`tool_result` pair
 * split across two polls still complete, since `claudeCodeTranscriptParser`
 * sees every line the file holds on every call. `FileTrackState.sentCount`
 * — how many of the deterministically-ordered Events a previous read
 * already sent — is what keeps a re-read from resending them.
 *
 * `sha256Hex` (src/hash.ts) is imported the same way
 * `src/sessions/cli.ts:5` already imports it, to feed
 * `projectFromProjectPath` — the one dependency this module reads outside
 * the FILES this change lists as editable or read-only; it is a tiny,
 * already-public, side-effect-free hash wrapper used identically elsewhere
 * in this repository.
 */

const USAGE_LINE =
  'usage: pnpm watch [--endpoint <url>] [--since <dur>] [--backfill] [--once] [--quiet]\n';

const DEFAULT_ENDPOINT = 'http://localhost:4318';
const DEFAULT_SINCE = '30m';
const RESCAN_INTERVAL_MS = 10_000;
// Whole-file re-parsing on growth is heavier than byte tailing, so this
// poll interval is 5s rather than the old 2s: see this change's own report
// for the measured poll duration across the real Transcript corpus.
const POLL_INTERVAL_MS = 5_000;
const HEARTBEAT_INTERVAL_MS = 30_000;

interface ResolvedIdentity {
  project: string;
  branch: string | undefined;
  label: string;
}

interface FollowedFile {
  filePath: string;
  track: FileTrackState;
  identity: ResolvedIdentity | undefined;
  sender: OtlpSender | undefined;
  clock: EventClock | undefined;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Lists every `*.jsonl` file exactly one directory below `projectsRoot`,
 * modified at or after `sinceMs`: the same one-level-down rule
 * `src/adapters/claude-code.ts`'s `transcriptPaths` and
 * `scripts/harvest-transcripts.ts`'s `listCandidates` already apply, here
 * run across every project directory rather than one derived from a single
 * `cwd`, because this watcher must pick up a Session in any project. A file
 * nested a level further down is a subagent Transcript carrying its
 * parent's Session identifier and is never listed here either.
 */
async function findTranscripts(projectsRoot: string, sinceMs: number): Promise<string[]> {
  let projectEntries;
  try {
    projectEntries = await readdir(projectsRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const paths: string[] = [];
  for (const projectEntry of projectEntries) {
    if (!projectEntry.isDirectory()) {
      continue;
    }
    const projectDir = join(projectsRoot, projectEntry.name);

    let fileEntries;
    try {
      fileEntries = await readdir(projectDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const fileEntry of fileEntries) {
      if (!fileEntry.isFile() || !fileEntry.name.endsWith('.jsonl')) {
        continue;
      }
      const filePath = join(projectDir, fileEntry.name);
      let fileStat;
      try {
        fileStat = await stat(filePath);
      } catch {
        continue;
      }
      if (fileStat.mtimeMs >= sinceMs) {
        paths.push(filePath);
      }
    }
  }

  return paths;
}

/**
 * The two file-system operations one followed file's poll needs, abstracted
 * behind an interface so `decideAndRead` and `initialTrackFor` are
 * testable with a fake reader, in the same injected-dependency style
 * `src/runner/lifecycle.ts`'s `LifecycleFs` already uses for the Runner's
 * imperative shell. `undefined` from either method means "could not read
 * this file right now" (missing, permission error, and so on), never a
 * thrown exception.
 */
export interface TranscriptReader {
  statSize(filePath: string): Promise<number | undefined>;
  readWhole(filePath: string): Promise<string | undefined>;
}

const realReader: TranscriptReader = {
  async statSize(filePath: string): Promise<number | undefined> {
    try {
      return (await stat(filePath)).size;
    } catch {
      return undefined;
    }
  },
  async readWhole(filePath: string): Promise<string | undefined> {
    try {
      return await readFile(filePath, 'utf8');
    } catch {
      return undefined;
    }
  },
};

/** What one poll decided about re-reading a file, and the content it read when it did. */
export interface ReadDecision {
  readonly shouldRead: boolean;
  readonly content: string | undefined;
  readonly fileSize: number | undefined;
  readonly baselineSentCount: number;
}

/**
 * Stats `filePath` through `reader`, and — only when `planFilePoll` (the
 * pure core) says the size actually changed — reads the whole file through
 * `reader` too. A `reader.statSize` failure (the file disappeared) yields
 * `shouldRead: false` and no read call at all; an unchanged size yields the
 * same, proved in tests by a `reader.readWhole` call count that stays at
 * zero. `baselineSentCount` is always `planFilePoll`'s own answer, carried
 * through even when nothing is read, so a caller that stat-only-polled a
 * file still knows what its own stored `sentCount` already covers.
 */
export async function decideAndRead(
  filePath: string,
  track: FileTrackState,
  reader: TranscriptReader,
): Promise<ReadDecision> {
  const fileSize = await reader.statSize(filePath);
  if (fileSize === undefined) {
    return {
      shouldRead: false,
      content: undefined,
      fileSize: undefined,
      baselineSentCount: track.sentCount,
    };
  }

  const plan = planFilePoll(track, fileSize);
  if (!plan.shouldRead) {
    return {
      shouldRead: false,
      content: undefined,
      fileSize,
      baselineSentCount: plan.baselineSentCount,
    };
  }

  const content = await reader.readWhole(filePath);
  return {
    shouldRead: content !== undefined,
    content,
    fileSize,
    baselineSentCount: plan.baselineSentCount,
  };
}

/**
 * The `FileTrackState` a newly discovered file should start from. With
 * `backfill`, that is simply `INITIAL_FILE_TRACK_STATE`: the first real
 * poll will see the whole file as growth from zero and send every Event in
 * it. Without `backfill`, this reads and parses the file once, right now,
 * to learn how many Events it already holds, and records that count as
 * already sent WITHOUT sending any of them — so a Session already running
 * when the watcher starts does not replay its history, while an Event
 * appended after this point still gets sent on a later poll.
 */
export async function initialTrackFor(
  filePath: string,
  backfill: boolean,
  project: string,
  reader: TranscriptReader,
): Promise<FileTrackState> {
  if (backfill) {
    return INITIAL_FILE_TRACK_STATE;
  }

  const decision = await decideAndRead(filePath, INITIAL_FILE_TRACK_STATE, reader);
  if (!decision.shouldRead || decision.content === undefined || decision.fileSize === undefined) {
    return INITIAL_FILE_TRACK_STATE;
  }

  const lines = linesOfWholeFile(decision.content);
  const result = parseEventsSince({
    lines,
    fileSize: decision.fileSize,
    project,
    baselineSentCount: 0,
  });
  return result.track;
}

/**
 * `git rev-parse --abbrev-ref HEAD` run in `cwd`. Returns `undefined` when
 * `cwd` is not a git repository or `git` fails for any other reason, per
 * this task's own rule — no detached-HEAD special case, unlike
 * `scripts/session-env.ts`'s `resolveBranch`, because this task's SPEC
 * does not ask for one.
 */
function resolveBranch(cwd: string): string | undefined {
  try {
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return branch === '' ? undefined : branch;
  } catch {
    return undefined;
  }
}

/**
 * Resolves the Session's identity (`sessionId`, `cwd`, and the earliest
 * Event time, for the label) via the pure `extractIdentity`, from `lines`
 * the caller already read — never re-reading the file itself. Only called
 * once per followed file, before that file's `identity` is cached, so this
 * never spawns `git` or rebuilds the label per poll. The `EventClock`
 * created here is the seam `createOtlpSender`'s `now` option exposes: its
 * `setNext` is called once per Event, immediately before that Event is
 * emitted, so the record the sender builds carries the Transcript's own
 * time rather than the moment this poll happened to run.
 */
function resolveIdentityFromLines(
  lines: readonly string[],
  endpoint: string,
): {
  identity: ResolvedIdentity | undefined;
  sender: OtlpSender | undefined;
  clock: EventClock | undefined;
} {
  const found = extractIdentity(lines);

  if (found.cwd === undefined) {
    return { identity: undefined, sender: undefined, clock: undefined };
  }

  const project = projectFromProjectPath(found.cwd, sha256Hex);
  const branch = resolveBranch(found.cwd);
  const firstEventAt =
    found.firstEventIso === undefined ? new Date() : new Date(found.firstEventIso);
  const label = buildSessionLabel({ cwdBasename: basename(found.cwd), branch, firstEventAt });

  const resourceAttributes = encodeResourceAttributes({
    project_path: found.cwd,
    session_label: label,
    branch,
  });

  const clock = createEventClock();
  const sender = createOtlpSender({
    serviceName: 'claude-code',
    env: { OTEL_EXPORTER_OTLP_ENDPOINT: endpoint, OTEL_RESOURCE_ATTRIBUTES: resourceAttributes },
    installSignalHandlers: false,
    now: clock.now,
  });

  return { identity: { project, branch, label }, sender, clock };
}

/** One poll of one followed file: re-reads it whole when it grew, parses it, and sends every new Event found. */
async function pollFile(state: FollowedFile, endpoint: string): Promise<number> {
  const decision = await decideAndRead(state.filePath, state.track, realReader);
  if (!decision.shouldRead || decision.content === undefined || decision.fileSize === undefined) {
    return 0;
  }

  const lines = linesOfWholeFile(decision.content);

  if (state.identity === undefined) {
    const resolved = resolveIdentityFromLines(lines, endpoint);
    if (resolved.identity !== undefined) {
      state.identity = resolved.identity;
      state.sender = resolved.sender;
      state.clock = resolved.clock;
    }
  }

  const result = parseEventsSince({
    lines,
    fileSize: decision.fileSize,
    project: state.identity?.project ?? 'unknown',
    baselineSentCount: decision.baselineSentCount,
  });

  state.track = result.track;

  let eventsSent = 0;
  if (state.sender !== undefined) {
    const sender = state.sender;
    for (const parsed of result.newEvents) {
      if (
        parsed.event.kind === 'model_call' ||
        parsed.event.kind === 'tool_call' ||
        parsed.event.kind === 'prompt'
      ) {
        state.clock?.setNext(eventTimeNano(parsed.timeUnixNano));
        sender.emit(parsed.event, eventNameFor(parsed.event.kind));
        eventsSent += 1;
      }
    }
    await sender.flush();
  }

  return eventsSent;
}

interface CliFlags {
  endpoint: string;
  since: string;
  backfill: boolean;
  once: boolean;
  quiet: boolean;
}

function parseFlags(argv: readonly string[]): CliFlags | undefined {
  let values: {
    endpoint?: string;
    since?: string;
    backfill?: boolean;
    once?: boolean;
    quiet?: boolean;
  };
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        endpoint: { type: 'string', default: DEFAULT_ENDPOINT },
        since: { type: 'string', default: DEFAULT_SINCE },
        backfill: { type: 'boolean', default: false },
        once: { type: 'boolean', default: false },
        quiet: { type: 'boolean', default: false },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch {
    return undefined;
  }

  return {
    endpoint: values.endpoint ?? DEFAULT_ENDPOINT,
    since: values.since ?? DEFAULT_SINCE,
    backfill: values.backfill === true,
    once: values.once === true,
    quiet: values.quiet === true,
  };
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  if (flags === undefined) {
    process.stderr.write(USAGE_LINE);
    process.exitCode = 2;
    return;
  }

  const parsedSinceMs = parseSince(flags.since, Date.now());
  if (parsedSinceMs === undefined) {
    process.stderr.write(USAGE_LINE);
    process.exitCode = 2;
    return;
  }

  // Destructured into plain `const` bindings so every nested function below
  // closes over a binding TypeScript can prove is never `undefined`, rather
  // than over `flags`/`parsedSinceMs` themselves: a nested function
  // declaration does not retain the enclosing narrowing on those two names.
  const { endpoint, backfill, once, quiet } = flags;
  const sinceMs: number = parsedSinceMs;

  const projectsRoot = join(homedir(), '.claude', 'projects');
  const followed = new Map<string, FollowedFile>();
  let totalEventsSent = 0;
  let lastSendAt: Date | undefined;

  async function rescan(): Promise<void> {
    const paths = await findTranscripts(projectsRoot, sinceMs);
    for (const filePath of paths) {
      if (followed.has(filePath)) {
        continue;
      }
      const track = await initialTrackFor(filePath, backfill, 'unknown', realReader);
      followed.set(filePath, {
        filePath,
        track,
        identity: undefined,
        sender: undefined,
        clock: undefined,
      });
    }
  }

  async function pollAll(): Promise<void> {
    for (const state of followed.values()) {
      let eventsSent: number;
      try {
        eventsSent = await pollFile(state, endpoint);
      } catch (error) {
        process.stderr.write(`agent-telemetry: watch poll failed (${describeError(error)})\n`);
        continue;
      }
      if (eventsSent > 0) {
        totalEventsSent += eventsSent;
        lastSendAt = new Date();
      }
    }
  }

  async function shutdownAll(): Promise<void> {
    await Promise.all(
      [...followed.values()].map((state) => state.sender?.shutdown() ?? Promise.resolve()),
    );
  }

  await rescan();
  await pollAll();

  if (once) {
    process.stdout.write(`transcripts: ${String(followed.size)}\n`);
    process.stdout.write(`events_sent: ${String(totalEventsSent)}\n`);
    await shutdownAll();
    return;
  }

  const rescanTimer = setInterval(() => {
    void rescan();
  }, RESCAN_INTERVAL_MS);
  const pollTimer = setInterval(() => {
    void pollAll();
  }, POLL_INTERVAL_MS);

  let heartbeatTimer: NodeJS.Timeout | undefined;
  if (!quiet) {
    heartbeatTimer = setInterval(() => {
      const lastSend = lastSendAt === undefined ? 'never' : lastSendAt.toISOString();
      process.stderr.write(
        `watch: transcripts=${String(followed.size)} events_sent=${String(totalEventsSent)} last_send=${lastSend}\n`,
      );
    }, HEARTBEAT_INTERVAL_MS);
  }

  let shuttingDown = false;
  const handleSigint = (): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    clearInterval(rescanTimer);
    clearInterval(pollTimer);
    if (heartbeatTimer !== undefined) {
      clearInterval(heartbeatTimer);
    }
    void shutdownAll().then(() => {
      process.off('SIGINT', handleSigint);
      process.exit(0);
    });
  };
  process.on('SIGINT', handleSigint);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
