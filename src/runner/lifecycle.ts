import { createWriteStream } from 'node:fs';
import { mkdir as fsMkdir, stat as fsStat } from 'node:fs/promises';

import type { Adapter } from '../adapters/index.js';
import type { OtlpSender } from '../events/otlp.js';
import { RUNNER_RUN_END, RUNNER_RUN_START } from '../events/event-names.js';
import { filterByRunId, foldRunAggregate } from '../events/fold.js';
import { readEventsFile } from '../events/read.js';
import type { ReadResult } from '../events/read.js';
import { waitForSettle } from '../events/settle.js';
import type { Event, ResultsRow, Task, Variant } from '../schema/index.js';
import type { CheckerResult } from './checker.js';
import { copyFixture, initWorkGit } from './fixture.js';
import {
  DEFAULT_GRACE_MS,
  advanceTimeout,
  assertCacheSupported,
  buildResultsRow,
  initialTimeoutState,
  runDirLayout,
} from './index.js';
import type { CacheState, TimeoutLimits, TimeoutState } from './index.js';

/**
 * The Runner's imperative shell: steps 1 to 10 of SPEC.md:410-432, carried
 * out for one Run. Every effect (file system, process spawn, network,
 * clock, sleep) arrives through the injected `deps`, so a test can prove no
 * path outside the Run directory is ever written.
 */

export interface LogSink {
  write(chunk: string): void;
  close(): Promise<void>;
}

export interface LifecycleFs {
  mkdir(path: string): Promise<void>;
  copyFixture(from: string, to: string): Promise<string[]>;
  initWorkGit(work: string): Promise<void>;
  openLog(path: string): Promise<LogSink>;
  byteLength(path: string): Promise<number>;
}

export interface RunInput {
  task: Task;
  variantName: string;
  variant: Variant;
  cache: CacheState;
  rep: number;
}

export interface LifecycleDeps {
  runsRoot: string;
  eventsPath: string;
  resultsPath: string;
  endpoint: string;
  project: string;
  projectPath: string;
  baseEnv: Record<string, string>;
  adapter: Adapter;
  fs: LifecycleFs;
  ulid: () => string;
  nowMs: () => number;
  nowIso: () => string;
  runChecker: (p: { command: string; cwd: string }) => Promise<CheckerResult>;
  createSender: (p: { serviceName: string; endpoint: string }) => OtlpSender;
  readWindow: (p: { path: string; startByte: number }) => Promise<ReadResult>;
  upsertRuns: (rows: readonly ResultsRow[], path: string) => Promise<number>;
  sleep: (ms: number) => Promise<void>;
  /** Defaults to 250. */
  pollIntervalMs?: number;
}

/** Guards the exit/timeout loop against a fake clock that never advances. */
const MAX_TIMEOUT_LOOP_ITERATIONS = 1_000_000;

export async function executeRun(input: RunInput, deps: LifecycleDeps): Promise<ResultsRow> {
  // Step 1: checked first, before any other statement, so a rejected
  // warm-cache Run records nothing on the (fake) file system.
  assertCacheSupported(input.cache);

  // Step 2: every per-Run path comes from `layout`, never built by hand.
  const runId = deps.ulid();
  const layout = runDirLayout(deps.runsRoot, runId);

  // Step 3.
  await deps.fs.mkdir(layout.root);
  await deps.fs.copyFixture(input.task.fixture, layout.work);
  await deps.fs.initWorkGit(layout.work);

  // Step 4: the byte window. `eventsPath` holds every past Run too, so
  // settle and aggregation read only the bytes appended after this point.
  const startByte = await deps.fs.byteLength(deps.eventsPath);

  // Step 5: the resource attributes, built once and reused for both
  // Events and the Agent's own telemetry environment.
  //
  // SPEC.md:422 names the `config` resource attribute and never defines
  // its content, and src/schema/resource.ts:6-8 already records that gap.
  // The Runner uses `config` for the cache state, because SPEC.md:435
  // makes `cache` a Results column with no other export path to an Event.
  //
  // `project_path` is included because the Collector derives the
  // `project` resource attribute from `project_path` and then deletes it
  // (compose/collector/config.yaml:32-35), and every Event read by
  // src/events/line.ts must carry `project` or it fails EventSchema. A
  // real bench Run once passed its Checker but reported turns=0, because
  // every Agent Event was dropped with the reason "project: Invalid
  // input: expected string, received undefined". scripts/record-live.ts:
  // 186-188 already sets project_path for the same reason.
  const resource: Record<string, string> = {
    run_id: runId,
    task: input.task.id,
    variant: input.variantName,
    config: input.cache,
    agent: deps.adapter.name,
    project_path: deps.projectPath,
  };

  // Step 6.
  //
  // `serviceName` must equal `deps.adapter.name`: the Collector overwrites
  // the resource `agent` attribute from `service.name`
  // (compose/collector/config.yaml:30).
  const sender = deps.createSender({ serviceName: deps.adapter.name, endpoint: deps.endpoint });

  // `session_id` is `runner:<run_id>` because the Agent's own Session
  // identifier does not exist yet at this step.
  const runStartEvent: Event = {
    kind: 'run_start',
    agent: deps.adapter.name,
    session_id: `runner:${runId}`,
    project: deps.project,
    run_id: runId,
    task: input.task.id,
    variant: input.variantName,
    config: input.cache,
    rep: input.rep,
  };
  sender.emit(runStartEvent, RUNNER_RUN_START);
  await sender.flush();

  // Step 7.
  const startedAtIso = deps.nowIso();
  const startedMs = deps.nowMs();

  // Step 8.
  const agentLog = await deps.fs.openLog(layout.agentLog);

  // Step 9.
  //
  // `OTEL_LOG_USER_PROMPTS` is never set here: hard prohibition 3 of
  // CLAUDE.md forbids exporting prompt text, tool input, and tool output,
  // and that variable would export the prompt.
  const env: Record<string, string> = {
    ...deps.baseEnv,
    ...deps.adapter.telemetryEnv({ endpoint: deps.endpoint, resource }),
  };
  const child = deps.adapter.launch({
    prompt: input.task.prompt,
    cwd: layout.work,
    env,
    mcpServers: input.variant.servers,
  });

  // Registered before the first poll (step 11), so an immediate exit from
  // the Agent process is never missed.
  //
  // A plain `let` reassigned only inside these closures defeats
  // TypeScript's control-flow narrowing: it has no notion that an
  // EventEmitter callback may run later, so it keeps treating later reads
  // as the type the variable held before the closures were ever defined.
  // A one-property box sidesteps that by making every read a property
  // access, which TypeScript narrows correctly regardless of the closure.
  const exitedBox: { current: { code: number | null } | null } = { current: null };
  child.once('exit', (code) => {
    exitedBox.current = { code };
  });
  child.once('error', () => {
    exitedBox.current = { code: null };
  });

  // Step 10: both streams may be null on the `ChildProcess` type, so an
  // explicit null check guards each, never a non-null assertion.
  if (child.stdout !== null) {
    child.stdout.on('data', (chunk: unknown) => {
      agentLog.write(String(chunk));
    });
  }
  if (child.stderr !== null) {
    child.stderr.on('data', (chunk: unknown) => {
      agentLog.write(String(chunk));
    });
  }

  // Step 11: wait for exit or timeout, driven by the pure reducer.
  const limits: TimeoutLimits = {
    timeout_ms: input.task.timeout_s * 1000,
    grace_ms: DEFAULT_GRACE_MS,
  };
  const pollIntervalMs = deps.pollIntervalMs ?? 250;

  let timeoutState: TimeoutState = initialTimeoutState();
  let iterations = 0;

  for (;;) {
    if (exitedBox.current !== null) {
      timeoutState = advanceTimeout(timeoutState, { type: 'exit' }, limits).state;
      break;
    }

    await deps.sleep(pollIntervalMs);
    const elapsedMs = deps.nowMs() - startedMs;
    const result = advanceTimeout(timeoutState, { type: 'tick', elapsed_ms: elapsedMs }, limits);
    timeoutState = result.state;

    if (result.action === 'send_sigterm') {
      child.kill('SIGTERM');
    } else if (result.action === 'send_sigkill') {
      child.kill('SIGKILL');
    }

    if (timeoutState.phase === 'exited') {
      break;
    }

    iterations += 1;
    if (iterations >= MAX_TIMEOUT_LOOP_ITERATIONS) {
      throw new Error(
        `Run ${runId}: timeout loop exceeded ${String(MAX_TIMEOUT_LOOP_ITERATIONS)} iterations`,
      );
    }
  }

  const exitCode = exitedBox.current === null ? null : exitedBox.current.code;

  // `wall_ms` covers the Agent process only. The Checker and the settle
  // wait below are deliberately outside it, so `pnpm report`'s median
  // wall time compares Agents rather than the Runner's own bookkeeping.
  const wallMs = Math.max(0, deps.nowMs() - startedMs);

  // Step 12.
  await agentLog.close();

  // Step 13.
  const checker = await deps.runChecker({ command: input.task.checker, cwd: layout.work });

  // Step 14: settle, driven by the test's fake clock through `deps.nowMs`
  // and `deps.sleep`.
  const countLines = async (): Promise<number> => {
    const result = await deps.readWindow({ path: deps.eventsPath, startByte });
    return filterByRunId(result.events, runId).length;
  };
  await waitForSettle({
    countLines,
    now: deps.nowMs,
    sleep: deps.sleep,
    pollIntervalMs: 1000,
  });

  // Step 15.
  const window = await deps.readWindow({ path: deps.eventsPath, startByte });
  const aggregate = foldRunAggregate(window.events, {
    runId,
    expectedTools: input.task.expected_tools,
  });

  // Step 17.
  const row = buildResultsRow({
    run_id: runId,
    started_at: startedAtIso,
    task: input.task.id,
    agent: deps.adapter.name,
    variant: input.variantName,
    cache: input.cache,
    rep: input.rep,
    wall_ms: wallMs,
    exit_code: exitCode,
    timed_out: timeoutState.timed_out,
    checker_exit_code: checker.exit_code,
    checker_output: checker.output,
    aggregate,
  });

  // Step 18: `exit_code` is included only when it is not null, because
  // `RunEndEventSchema` has `exit_code` optional and not nullable.
  const runEndEvent: Event = {
    kind: 'run_end',
    agent: deps.adapter.name,
    session_id: `runner:${runId}`,
    project: deps.project,
    run_id: runId,
    task: input.task.id,
    variant: input.variantName,
    config: input.cache,
    rep: input.rep,
    wall_ms: wallMs,
    turns: aggregate.turns,
    tool_calls: aggregate.tool_calls,
    mcp_server_calls: aggregate.mcp_server_calls,
    input_tokens: aggregate.input_tokens,
    output_tokens: aggregate.output_tokens,
    cache_read_tokens: aggregate.cache_read_tokens,
    pass: row.pass,
    timed_out: timeoutState.timed_out,
    expected_tools_hit: aggregate.expected_tools_hit,
    ...(exitCode === null ? {} : { exit_code: exitCode }),
  };
  sender.emit(runEndEvent, RUNNER_RUN_END);
  await sender.flush();
  await sender.shutdown();

  // Step 19.
  await deps.upsertRuns([row], deps.resultsPath);

  // Step 20.
  //
  // The Runner does not write the `sessions` table. SPEC.md:438-439 says a
  // reader queries the `sessions` table filtered by `run_id`; `pnpm
  // sessions` builds that table, and the Agent's own Events already carry
  // `run_id` as a resource attribute, so the link exists without the
  // Runner writing anything here.
  return row;
}

/** Minimal shape of a Node error that carries a `code`, used without a cast. */
interface ErrnoLike {
  code?: string;
}

function hasErrorCode(error: unknown): error is ErrnoLike {
  return typeof error === 'object' && error !== null && 'code' in error;
}

function isMissingFileError(error: unknown): boolean {
  return hasErrorCode(error) && error.code === 'ENOENT';
}

/** The real `LifecycleFs`, built on `node:fs` and the fixture edge module. */
export function createLifecycleFs(): LifecycleFs {
  return {
    mkdir: async (path) => {
      await fsMkdir(path, { recursive: true });
    },
    copyFixture: async (from, to) => copyFixture(from, to),
    initWorkGit: async (work) => {
      await initWorkGit(work);
    },
    openLog: (path) =>
      new Promise((resolve) => {
        const stream = createWriteStream(path, { flags: 'a' });
        stream.once('open', () => {
          resolve({
            write: (chunk) => {
              stream.write(chunk);
            },
            close: () =>
              new Promise<void>((resolveClose) => {
                stream.once('close', () => {
                  resolveClose();
                });
                stream.end();
              }),
          });
        });
      }),
    byteLength: async (path) => {
      try {
        const info = await fsStat(path);
        return info.size;
      } catch (error) {
        if (isMissingFileError(error)) {
          return 0;
        }
        throw error;
      }
    },
  };
}

/**
 * The real `readWindow`, built on `../events/read.js`. A rotation between
 * two reads can leave the Events file absent, or smaller than the recorded
 * `startByte`; either case reads from offset 0, because reusing the old
 * offset against a rotated file would skip lines or read past its end.
 */
export async function readEventsWindow(p: {
  path: string;
  startByte: number;
}): Promise<ReadResult> {
  let exists = true;
  let size = 0;

  try {
    const info = await fsStat(p.path);
    size = info.size;
  } catch (error) {
    if (isMissingFileError(error)) {
      exists = false;
    } else {
      throw error;
    }
  }

  const startByte = !exists || size < p.startByte ? 0 : p.startByte;
  return readEventsFile(p.path, { startByte });
}
