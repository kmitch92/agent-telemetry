import { join } from 'node:path';
import { parse } from 'yaml';

import { ResultsRowSchema, TaskSchema, VariantsFileSchema } from '../schema/index.js';
import type { ResultsRow, Task, Variant, VariantsFile } from '../schema/index.js';
import type { RunAggregate } from '../events/fold.js';

/**
 * The Runner's pure core (SPEC.md's Run lifecycle). No `node:fs`, no
 * `node:child_process`, no `node:os` import: parsing Task and Variant
 * YAML, building per-Run paths, the timeout reducer, and shaping a
 * Results row only. `join` from `node:path` is the one platform import,
 * used solely to compute paths, never to touch the file system. The
 * thin edge modules (fixture.ts, checker.ts, store.ts) and the
 * imperative shell (lifecycle.ts) belong to other workers.
 */

/** Whether a Run keeps its Variant's MCP server processes alive across Runs. */
export type CacheState = 'cold' | 'warm';

/** Parses Task YAML text, then validates it against `TaskSchema`. */
export function parseTaskYaml(text: string): Task {
  return TaskSchema.parse(parse(text));
}

/** Parses Variant file YAML text, then validates it against `VariantsFileSchema`. */
export function parseVariantsYaml(text: string): VariantsFile {
  return VariantsFileSchema.parse(parse(text));
}

/**
 * Looks up `name` in `file.variants`. Throws, naming the unknown Variant
 * and listing every known name, when `name` is absent.
 */
export function resolveVariant(file: VariantsFile, name: string): Variant {
  const variant = file.variants[name];
  if (variant === undefined) {
    const knownNames = Object.keys(file.variants).sort().join(', ');
    throw new Error(`unknown Variant '${name}': the Variant file defines ${knownNames}`);
  }
  return variant;
}

/**
 * The single source of every per-Run path. Nothing else in the Runner
 * builds a per-Run path by hand.
 */
export interface RunDirLayout {
  root: string;
  work: string;
  mcpConfig: string;
  agentLog: string;
  checkerLog: string;
}

export function runDirLayout(runsRoot: string, runId: string): RunDirLayout {
  const root = join(runsRoot, runId);
  return {
    root,
    work: join(root, 'work'),
    mcpConfig: join(root, 'mcp.json'),
    agentLog: join(root, 'agent.log'),
    checkerLog: join(root, 'checker.log'),
  };
}

/**
 * Drops `.git` and every entry under it from a flat list of Fixture
 * entries, keeping the order of the survivors. The edge module
 * `fixture.ts` lists the real directory and hands the result here.
 */
export function planFixtureCopy(entries: readonly string[]): string[] {
  return entries.filter((entry) => entry !== '.git' && !entry.startsWith('.git/'));
}

/** `turns === 0` returns 0; otherwise `inputTokens / turns`. */
export function inputTokensPerTurn(inputTokens: number, turns: number): number {
  return turns === 0 ? 0 : inputTokens / turns;
}

/**
 * The Agent-launch timeout reducer's phase, per the SIGTERM then SIGKILL
 * sequence in SPEC.md:424-425.
 */
export type TimeoutPhase = 'running' | 'term_sent' | 'kill_sent' | 'exited';

export interface TimeoutState {
  phase: TimeoutPhase;
  timed_out: boolean;
  term_at_ms: number | null;
}

export type TimeoutInput = { type: 'tick'; elapsed_ms: number } | { type: 'exit' };

export type TimeoutAction = 'none' | 'send_sigterm' | 'send_sigkill';

export interface TimeoutLimits {
  timeout_ms: number;
  grace_ms: number;
}

/** SPEC.md's Run lifecycle step 6: SIGKILL follows SIGTERM by 10 seconds. */
export const DEFAULT_GRACE_MS = 10_000;

export function initialTimeoutState(): TimeoutState {
  return { phase: 'running', timed_out: false, term_at_ms: null };
}

/**
 * Pure reducer with no timer of its own: the caller supplies every tick
 * and the exit notice. Every returned state is a fresh object; the input
 * state is never mutated. `term_at_ms` carries forward unchanged into
 * `kill_sent` and `exited`.
 */
export function advanceTimeout(
  state: TimeoutState,
  input: TimeoutInput,
  limits: TimeoutLimits,
): { state: TimeoutState; action: TimeoutAction } {
  switch (state.phase) {
    case 'running': {
      if (input.type === 'exit') {
        return {
          state: { phase: 'exited', timed_out: false, term_at_ms: state.term_at_ms },
          action: 'none',
        };
      }
      if (input.elapsed_ms < limits.timeout_ms) {
        return { state: { ...state }, action: 'none' };
      }
      return {
        state: { phase: 'term_sent', timed_out: state.timed_out, term_at_ms: input.elapsed_ms },
        action: 'send_sigterm',
      };
    }
    case 'term_sent': {
      if (input.type === 'exit') {
        return {
          state: { phase: 'exited', timed_out: true, term_at_ms: state.term_at_ms },
          action: 'none',
        };
      }
      // A null term_at_ms cannot happen through this reducer: term_sent is
      // only ever entered with term_at_ms set. Treat it as below the
      // threshold rather than reach for a non-null assertion.
      if (state.term_at_ms === null) {
        return { state: { ...state }, action: 'none' };
      }
      if (input.elapsed_ms < state.term_at_ms + limits.grace_ms) {
        return { state: { ...state }, action: 'none' };
      }
      return {
        state: { phase: 'kill_sent', timed_out: state.timed_out, term_at_ms: state.term_at_ms },
        action: 'send_sigkill',
      };
    }
    case 'kill_sent': {
      if (input.type === 'exit') {
        return {
          state: { phase: 'exited', timed_out: true, term_at_ms: state.term_at_ms },
          action: 'none',
        };
      }
      return { state: { ...state }, action: 'none' };
    }
    case 'exited':
      return { state: { ...state }, action: 'none' };
  }
}

/** Everything `buildResultsRow` needs to shape one row of the Results table. */
export interface ResultsRowInput {
  run_id: string;
  started_at: string;
  task: string;
  agent: string;
  variant: string;
  cache: CacheState;
  rep: number;
  wall_ms: number;
  exit_code: number | null;
  timed_out: boolean;
  checker_exit_code: number | null;
  checker_output: string;
  aggregate: RunAggregate;
}

/**
 * Shapes one Results row from `input`, then validates it against
 * `ResultsRowSchema` so an invalid row throws here rather than at the
 * DuckDB boundary. `pass` is the Checker definition in CLAUDE.md:
 * `checker_exit_code === 0`.
 */
export function buildResultsRow(input: ResultsRowInput): ResultsRow {
  const row = {
    run_id: input.run_id,
    started_at: input.started_at,
    task: input.task,
    agent: input.agent,
    variant: input.variant,
    cache: input.cache,
    rep: input.rep,
    pass: input.checker_exit_code === 0,
    exit_code: input.exit_code,
    timed_out: input.timed_out,
    wall_ms: input.wall_ms,
    turns: input.aggregate.turns,
    tool_calls: input.aggregate.tool_calls,
    mcp_server_calls: input.aggregate.mcp_server_calls,
    input_tokens: input.aggregate.input_tokens,
    output_tokens: input.aggregate.output_tokens,
    cache_read_tokens: input.aggregate.cache_read_tokens,
    input_tokens_per_turn: inputTokensPerTurn(input.aggregate.input_tokens, input.aggregate.turns),
    cost_usd: input.aggregate.cost_usd,
    expected_tools_hit: input.aggregate.expected_tools_hit,
    cache_hits: input.aggregate.cache_hits,
    checker_output: input.checker_output,
  };

  return ResultsRowSchema.parse(row);
}

/**
 * Names both sides of an unresolved contradiction between SPEC.md and
 * the code, per the "Read first" section of
 * `CLAUDE.md`: SPEC.md:416-417 requires
 * `cache=warm` to keep the Variant's MCP server processes alive across
 * Runs, but `src/adapters/claude-code.ts:85-96` hands the Agent
 * `--mcp-config`, so the Agent owns each MCP server as its own child and
 * every server dies with the Agent. This session reporting the
 * contradiction does not choose a side; it names the file, the line,
 * and the exact contradiction, then waits.
 */
export const WARM_CACHE_BLOCKED =
  'cache=warm is blocked: SPEC.md:416-417 requires keeping the Variant MCP server processes alive across Runs, but src/adapters/claude-code.ts:85-96 hands the Agent --mcp-config so the Agent owns each MCP server as its own child and every server dies with the Agent. This contradiction between SPEC.md and the code is unresolved; use cache=cold.';

/** Throws `WARM_CACHE_BLOCKED` for `cache === 'warm'`; returns otherwise. */
export function assertCacheSupported(cache: CacheState): void {
  if (cache === 'warm') {
    throw new Error(WARM_CACHE_BLOCKED);
  }
}
