import { setTimeout as sleepFor } from 'node:timers/promises';

/**
 * Pure settle rule (SPEC.md:427): a Run is settled once its Event line count
 * stops growing for a quiet window, or once a hard ceiling is reached,
 * whichever comes first. No file system import here: the waiter takes its
 * clock, its sleep, and its line count by injection.
 */

/** Quiet window, in milliseconds, with no new line before a Run settles as `quiet`. */
export const SETTLE_QUIET_MS = 5000;

/** Hard ceiling, in milliseconds, after which a Run settles as `max_elapsed` regardless. */
export const SETTLE_MAX_MS = 30000;

/** The settle predicate's working memory: the last observed count and its two clocks. */
export interface SettleState {
  lineCount: number;
  lastChangeMs: number;
  startMs: number;
}

/** The predicate's answer: not yet settled, or settled with the reason that fired. */
export type SettleVerdict =
  | { settled: false }
  | { settled: true; reason: 'quiet' }
  | { settled: true; reason: 'max_elapsed' };

/** Builds the initial state: nothing has changed yet, so lastChangeMs equals startMs. */
export function startSettleState(nowMs: number, lineCount: number): SettleState {
  return { lineCount, lastChangeMs: nowMs, startMs: nowMs };
}

/**
 * Folds one observation into a new state, never mutating `state`. `lastChangeMs`
 * only moves to the observation time when the observed count differs from the
 * current count; `startMs` is fixed for the life of a wait.
 */
export function advanceSettleState(
  state: SettleState,
  observation: { lineCount: number; nowMs: number },
): SettleState {
  const countChanged = observation.lineCount !== state.lineCount;
  return {
    lineCount: observation.lineCount,
    lastChangeMs: countChanged ? observation.nowMs : state.lastChangeMs,
    startMs: state.startMs,
  };
}

/**
 * Pure predicate, holds no clock of its own. Checks `max_elapsed` before `quiet`
 * so the hard ceiling wins when both windows have elapsed at the same instant.
 */
export function settleVerdict(
  state: SettleState,
  nowMs: number,
  options?: { quietMs?: number; maxMs?: number },
): SettleVerdict {
  const quietMs = options?.quietMs ?? SETTLE_QUIET_MS;
  const maxMs = options?.maxMs ?? SETTLE_MAX_MS;

  if (nowMs - state.startMs >= maxMs) {
    return { settled: true, reason: 'max_elapsed' };
  }
  if (nowMs - state.lastChangeMs >= quietMs) {
    return { settled: true, reason: 'quiet' };
  }
  return { settled: false };
}

/** Options for `waitForSettle`; the line counter, clock, and sleep are all injected. */
export interface SettleOptions {
  countLines: () => Promise<number>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  quietMs?: number;
  maxMs?: number;
}

/** The outcome of a completed wait: which reason fired, the final count, and the duration. */
export interface SettleResult {
  reason: 'quiet' | 'max_elapsed';
  lineCount: number;
  elapsedMs: number;
}

/**
 * Polls `countLines` on `pollIntervalMs`, folding each observation with
 * `advanceSettleState` and checking `settleVerdict` after every poll, until one
 * settles. The verdict is never checked before the first sleep, since the quiet
 * gap would read as zero at that instant.
 */
export async function waitForSettle(options: SettleOptions): Promise<SettleResult> {
  const now = options.now ?? Date.now;
  const sleep: (ms: number) => Promise<void> = options.sleep ?? sleepFor;
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const quietMs = options.quietMs ?? SETTLE_QUIET_MS;
  const maxMs = options.maxMs ?? SETTLE_MAX_MS;

  const elapsedStartMs = now();
  const firstCount = await options.countLines();
  let state = startSettleState(elapsedStartMs, firstCount);

  for (;;) {
    await sleep(pollIntervalMs);
    const count = await options.countLines();
    state = advanceSettleState(state, { lineCount: count, nowMs: now() });
    const verdict = settleVerdict(state, now(), { quietMs, maxMs });
    if (verdict.settled) {
      return {
        reason: verdict.reason,
        lineCount: state.lineCount,
        elapsedMs: now() - elapsedStartMs,
      };
    }
  }
}
