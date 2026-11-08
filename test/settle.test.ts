import { describe, expect, it, vi } from 'vitest';
import {
  SETTLE_MAX_MS,
  SETTLE_QUIET_MS,
  advanceSettleState,
  settleVerdict,
  startSettleState,
  waitForSettle,
} from '../src/events/settle.js';
import type { SettleState, SettleVerdict } from '../src/events/settle.js';

function createFakeClock(startMs: number): {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
} {
  let currentMs = startMs;
  const now = (): number => currentMs;
  const sleep = (ms: number): Promise<void> => {
    currentMs += ms;
    return Promise.resolve();
  };
  return { now, sleep };
}

function scriptedCountLines(script: number[]): ReturnType<typeof vi.fn<() => Promise<number>>> {
  let index = 0;
  const lastValue = script.length > 0 ? (script[script.length - 1] ?? 0) : 0;
  return vi.fn<() => Promise<number>>(() => {
    const candidate = index < script.length ? (script[index] ?? lastValue) : lastValue;
    index += 1;
    return Promise.resolve(candidate);
  });
}

describe('startSettleState', () => {
  it('sets startMs and lastChangeMs to the given time', () => {
    const state = startSettleState(500, 3);

    expect(state).toEqual({ startMs: 500, lastChangeMs: 500, lineCount: 3 });
  });
});

interface VerdictCase {
  readonly description: string;
  readonly state: SettleState;
  readonly nowMs: number;
  readonly expected: SettleVerdict;
}

const verdictCases: VerdictCase[] = [
  {
    description: 'neither the quiet window nor the max window has elapsed',
    state: { startMs: 1000, lastChangeMs: 1000, lineCount: 3 },
    nowMs: 1000,
    expected: { settled: false },
  },
  {
    description: 'the quiet window has elapsed and the max window has not',
    state: { startMs: 1000, lastChangeMs: 1000, lineCount: 3 },
    nowMs: 6000,
    expected: { settled: true, reason: 'quiet' },
  },
  {
    description: 'the max window has elapsed and the quiet window has not',
    state: { startMs: 1000, lastChangeMs: 30900, lineCount: 3 },
    nowMs: 31000,
    expected: { settled: true, reason: 'max_elapsed' },
  },
  {
    description: 'both windows have elapsed at once, and max_elapsed wins',
    state: { startMs: 1000, lastChangeMs: 1000, lineCount: 3 },
    nowMs: 31000,
    expected: { settled: true, reason: 'max_elapsed' },
  },
];

describe('settleVerdict, predicate table', () => {
  it.each(verdictCases)('settles correctly: $description', ({ state, nowMs, expected }) => {
    expect(settleVerdict(state, nowMs)).toEqual(expected);
  });
});

describe('settleVerdict, exact boundaries', () => {
  it('is not settled when the quiet gap is 4999ms', () => {
    const state: SettleState = { startMs: 0, lastChangeMs: 0, lineCount: 1 };
    expect(settleVerdict(state, 4999)).toEqual({ settled: false });
  });

  it('is quiet when the quiet gap is exactly 5000ms', () => {
    const state: SettleState = { startMs: 0, lastChangeMs: 0, lineCount: 1 };
    expect(settleVerdict(state, 5000)).toEqual({ settled: true, reason: 'quiet' });
  });

  it('is not max_elapsed when the total elapsed time is 29999ms', () => {
    const state: SettleState = { startMs: 0, lastChangeMs: 29999, lineCount: 1 };
    expect(settleVerdict(state, 29999)).toEqual({ settled: false });
  });

  it('is max_elapsed when the total elapsed time is exactly 30000ms', () => {
    const state: SettleState = { startMs: 0, lastChangeMs: 30000, lineCount: 1 };
    expect(settleVerdict(state, 30000)).toEqual({ settled: true, reason: 'max_elapsed' });
  });
});

describe('settleVerdict, custom thresholds', () => {
  it('uses a custom quietMs instead of the default', () => {
    const state: SettleState = { startMs: 0, lastChangeMs: 0, lineCount: 1 };
    expect(settleVerdict(state, 1000, { quietMs: 1000 })).toEqual({
      settled: true,
      reason: 'quiet',
    });
  });

  it('uses a custom maxMs instead of the default', () => {
    const state: SettleState = { startMs: 0, lastChangeMs: 1999, lineCount: 1 };
    expect(settleVerdict(state, 2000, { maxMs: 2000 })).toEqual({
      settled: true,
      reason: 'max_elapsed',
    });
  });
});

describe('advanceSettleState', () => {
  it('returns a new object and keeps lastChangeMs when the count is unchanged', () => {
    const state: SettleState = { startMs: 0, lastChangeMs: 100, lineCount: 5 };
    const next = advanceSettleState(state, { lineCount: 5, nowMs: 9000 });

    expect(next).not.toBe(state);
    expect(next.lastChangeMs).toBe(100);
    expect(next.startMs).toBe(0);
    expect(next.lineCount).toBe(5);
  });

  it('moves lastChangeMs to the observation time when the count changes', () => {
    const state: SettleState = { startMs: 0, lastChangeMs: 100, lineCount: 5 };
    const next = advanceSettleState(state, { lineCount: 6, nowMs: 9000 });

    expect(next.lastChangeMs).toBe(9000);
    expect(next.startMs).toBe(0);
    expect(next.lineCount).toBe(6);
  });

  it('does not mutate the input state', () => {
    const state: SettleState = { startMs: 0, lastChangeMs: 100, lineCount: 5 };
    const before = { ...state };

    advanceSettleState(state, { lineCount: 6, nowMs: 9000 });

    expect(state).toEqual(before);
  });
});

describe('waitForSettle, quiet after no growth', () => {
  it('settles with reason quiet when the line count never changes', async () => {
    const { now, sleep } = createFakeClock(1000);
    const countLines = vi.fn<() => Promise<number>>(() => Promise.resolve(10));

    const result = await waitForSettle({ countLines, now, sleep });

    expect(result.reason).toBe('quiet');
    expect(result.lineCount).toBe(10);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(SETTLE_QUIET_MS);
  });

  it('calls countLines more than once before reaching a quiet verdict', async () => {
    const { now, sleep } = createFakeClock(0);
    const countLines = vi.fn<() => Promise<number>>(() => Promise.resolve(5));

    await waitForSettle({ countLines, now, sleep });

    expect(countLines.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

describe('waitForSettle, max_elapsed after continuous growth', () => {
  it('settles with reason max_elapsed when the line count keeps changing', async () => {
    const { now, sleep } = createFakeClock(0);
    let lines = 0;
    const countLines = vi.fn<() => Promise<number>>(() => {
      lines += 1;
      return Promise.resolve(lines);
    });

    const result = await waitForSettle({ countLines, now, sleep });

    expect(result.reason).toBe('max_elapsed');
    expect(result.elapsedMs).toBeGreaterThanOrEqual(SETTLE_MAX_MS);
  });
});

describe('waitForSettle, late arrival resets the quiet window', () => {
  it('reports reason quiet with the larger count after a late growth', async () => {
    const { now, sleep } = createFakeClock(0);
    const countLines = scriptedCountLines([10, 10, 10, 10, 11]);

    const result = await waitForSettle({ countLines, now, sleep });

    expect(result.reason).toBe('quiet');
    expect(result.lineCount).toBe(11);
  });
});
