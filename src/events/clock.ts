/**
 * A wall clock reading on its own is not enough to key an Event. The
 * previous `defaultNow` returned `BigInt(Date.now()) * 1_000_000n`, a
 * millisecond reading padded with six zeros, so every Event emitted inside
 * the same millisecond carried an identical `timeUnixNano`. Loki
 * de-duplicates a log line that shares its stream labels, its timestamp
 * and its body with an earlier line, and an Event body is an empty
 * string, so a burst of same-millisecond Events collapsed into one stored
 * line. `createMonotonicNanoClock` keeps every call strictly greater than
 * the one before it, which removes the collision.
 */

/**
 * Builds a clock that returns a strictly increasing nanosecond `bigint` on
 * every call. `wallClockMs` defaults to `Date.now`. Each call computes a
 * candidate from the current wall-clock reading; when that candidate is
 * greater than the previously returned value it is returned as-is,
 * otherwise the previous value plus one nanosecond is returned instead.
 * This keeps the clock strictly increasing even when the wall clock is
 * frozen or moves backwards. Each call to `createMonotonicNanoClock`
 * closes over its own previous value, so two clocks never interfere with
 * each other.
 */
export function createMonotonicNanoClock(wallClockMs: () => number = Date.now): () => bigint {
  let previous: bigint | undefined;

  return function nextNano(): bigint {
    const candidate = BigInt(wallClockMs()) * 1_000_000n;

    if (previous === undefined || candidate > previous) {
      previous = candidate;
      return candidate;
    }

    previous = previous + 1n;
    return previous;
  };
}
