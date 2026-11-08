import { describe, expect, it } from 'vitest';
import { createMonotonicNanoClock } from '../src/events/clock.js';

describe('createMonotonicNanoClock', () => {
  it('increments the nanosecond tail on three successive calls against a frozen wall clock', () => {
    const clock = createMonotonicNanoClock(() => 5);

    expect(clock()).toBe(5000000n);
    expect(clock()).toBe(5000001n);
    expect(clock()).toBe(5000002n);
  });

  it('respects an advancing wall clock', () => {
    const readings = [5, 6];
    let index = 0;
    const clock = createMonotonicNanoClock(() => {
      const value = readings[index];
      index += 1;
      return value ?? 6;
    });

    expect(clock()).toBe(5000000n);
    expect(clock()).toBe(6000000n);
  });

  it('still increases when the wall clock moves backwards', () => {
    const readings = [5, 4];
    let index = 0;
    const clock = createMonotonicNanoClock(() => {
      const value = readings[index];
      index += 1;
      return value ?? 4;
    });

    expect(clock()).toBe(5000000n);
    expect(clock()).toBe(5000001n);
  });

  it('produces one thousand strictly increasing values against a frozen wall clock, with no collisions', () => {
    const clock = createMonotonicNanoClock(() => 5);

    const values: bigint[] = [];
    for (let i = 0; i < 1000; i += 1) {
      values.push(clock());
    }

    for (let i = 1; i < values.length; i += 1) {
      const previous = values[i - 1];
      const current = values[i];
      if (previous === undefined || current === undefined) {
        throw new Error('expected both values to be defined');
      }
      expect(current > previous).toBe(true);
    }

    const last = values[values.length - 1];
    expect(last).toBe(5000999n);

    const uniqueStrings = new Set(values.map((value) => value.toString()));
    expect(uniqueStrings.size).toBe(1000);
  });

  it('keeps two clocks built from two separate calls independent', () => {
    const first = createMonotonicNanoClock(() => 5);
    const second = createMonotonicNanoClock(() => 5);

    expect(first()).toBe(5000000n);
    expect(second()).toBe(5000000n);
  });

  it('returns a strictly increasing bigint on two successive calls with no argument', () => {
    const clock = createMonotonicNanoClock();

    const first = clock();
    const second = clock();

    expect(second > first).toBe(true);
    expect(first >= BigInt(Date.now() - 1000) * 1000000n).toBe(true);
  });
});
