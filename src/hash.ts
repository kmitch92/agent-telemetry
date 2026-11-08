import { createHash } from 'node:crypto';

/**
 * The one edge module in this change. Wraps `node:crypto` so every other
 * module touching an identifier can stay pure and take a hash function by
 * injection instead of importing this one directly.
 */

/**
 * Returns a SHA-256 hex digest of `value`, reshaped into the 8-4-4-4-12
 * hyphenated form a UUID uses, so a hashed session identifier still looks
 * like a session identifier to every downstream schema. Deterministic, no
 * salt: the same `value` always yields the same digest.
 */
export function hashId(value: string): string {
  const digest = createHash('sha256').update(value).digest('hex').slice(0, 32);

  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    digest.slice(12, 16),
    digest.slice(16, 20),
    digest.slice(20, 32),
  ].join('-');
}
