import { createHash, timingSafeEqual } from 'crypto';

/**
 * Fast-path validation digest for an API key: hex SHA-256 of the raw key.
 *
 * bcrypt is the right tool for low-entropy secrets (passwords), where its cost
 * factor slows offline guessing. API keys are 128 bits of CSPRNG output, so there
 * is nothing to guess: an unkeyed SHA-256 is already preimage-resistant at that
 * entropy, and validating costs microseconds instead of a cost-12 bcrypt round.
 * Deliberately unkeyed (no server-side pepper): a pepper would add a secret every
 * stage must provision before the fast path works, and rotating it would silently
 * invalidate every stored digest.
 */
export function computeKeyDigest(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

/** Constant-time check of `key` against a stored digest. */
export function keyDigestMatches(key: string, storedDigest: string): boolean {
  const expected = Buffer.from(storedDigest, 'hex');
  const actual = Buffer.from(computeKeyDigest(key), 'hex');
  // timingSafeEqual throws on a length mismatch; a malformed stored value is a miss.
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
