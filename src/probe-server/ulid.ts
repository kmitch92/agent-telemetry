import { randomBytes as nodeRandomBytes } from 'node:crypto';

/**
 * Pure Crockford base32 ULID (Universally Unique Lexicographically Sortable
 * Identifier) factory. The only `node:*` import is `randomBytes`, used
 * solely to build the default random source; every other line here is pure.
 */

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const RANDOM_BYTE_COUNT = 10;
const TIMESTAMP_CHAR_COUNT = 10;
const RANDOM_CHAR_COUNT = 16;
const RANDOM_BIT_COUNT = BigInt(RANDOM_CHAR_COUNT * 5);
const RANDOM_MASK = (1n << RANDOM_BIT_COUNT) - 1n;

function encodeBigIntToBase32(value: bigint, charCount: number): string {
  let result = '';
  for (let index = charCount - 1; index >= 0; index -= 1) {
    const shift = BigInt(index * 5);
    const chunk = Number((value >> shift) & 0x1fn);
    result += ALPHABET.charAt(chunk);
  }
  return result;
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte);
  }
  return value;
}

/**
 * Returns a function that produces 26-character Crockford base32 ULIDs: the
 * first 10 characters encode a 48-bit millisecond timestamp, the last 16
 * encode 80 bits of randomness. Two identifiers minted inside the same
 * millisecond keep strictly increasing order because the random part is
 * incremented by one on every call that shares the previous timestamp,
 * starting from whatever random part the previous call drew (including an
 * all-zero one).
 */
export function createUlidFactory(
  now?: () => number,
  randomBytes?: (byteCount: number) => Uint8Array,
): () => string {
  const resolvedNow = now ?? Date.now;
  const resolvedRandomBytes =
    randomBytes ?? ((byteCount: number): Uint8Array => nodeRandomBytes(byteCount));

  let lastTimestamp: number | undefined;
  let lastRandom = 0n;

  return function createUlid(): string {
    const timestamp = resolvedNow();

    if (lastTimestamp !== undefined && timestamp === lastTimestamp) {
      lastRandom = (lastRandom + 1n) & RANDOM_MASK;
    } else {
      lastTimestamp = timestamp;
      lastRandom = bytesToBigInt(resolvedRandomBytes(RANDOM_BYTE_COUNT));
    }

    const timestampPart = encodeBigIntToBase32(BigInt(Math.trunc(timestamp)), TIMESTAMP_CHAR_COUNT);
    const randomPart = encodeBigIntToBase32(lastRandom, RANDOM_CHAR_COUNT);
    return `${timestampPart}${randomPart}`;
  };
}
