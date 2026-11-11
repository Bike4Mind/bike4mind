import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Email verification and email-change tokens are stored as this SHA-256 hex digest; only the raw
 * token goes out in the email link. Lookups and comparisons take the raw token.
 */
export const hashEmailToken = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex');

// Tokens issued before hashing were stored as the raw UUID and expire within 24 hours of issue, so a
// plaintext match is still honoured for UUID-shaped input. A stored digest is never UUID-shaped, so
// presenting one cannot match itself. Safe to delete once every pre-hash token has expired.
const LEGACY_PLAINTEXT_TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Stored values that a raw token may match: its digest, plus itself for a legacy plaintext token. */
export const emailTokenStoredValues = (token: string): string[] => {
  if (!token) return [];
  return LEGACY_PLAINTEXT_TOKEN.test(token) ? [hashEmailToken(token), token] : [hashEmailToken(token)];
};

/** Constant-time check that a raw token matches the stored value. */
export const emailTokenMatches = (token: string, stored: string | null | undefined): boolean => {
  if (!stored) return false;
  const storedBuf = Buffer.from(stored, 'utf8');
  return emailTokenStoredValues(token).some(candidate => {
    const candidateBuf = Buffer.from(candidate, 'utf8');
    return candidateBuf.length === storedBuf.length && timingSafeEqual(candidateBuf, storedBuf);
  });
};
