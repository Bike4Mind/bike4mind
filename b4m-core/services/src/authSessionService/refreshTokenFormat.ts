import { randomBytes, createHash } from 'crypto';

/**
 * Opaque refresh-token format for the session store: `<sid>.<secret>`.
 *
 * The secret is high-entropy random bytes; only its sha256 hash is persisted on the AuthSession
 * (never the raw secret). The `sid` prefix lets the refresh endpoint locate the session in one
 * lookup without a separate index on the hash. A legacy JWT refresh token has THREE dot-separated
 * segments, so a two-segment token is unambiguously the opaque form (see `isOpaqueRefreshToken`).
 */

/** New random refresh secret (URL-safe, no dots so it can't confuse the `sid.secret` split). */
export function generateRefreshSecret(): string {
  return randomBytes(32).toString('base64url');
}

/** sha256 hex of a refresh secret. Stored on the session; compared against the presented secret. */
export function hashRefreshSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

export function buildRefreshToken(sid: string, secret: string): string {
  return `${sid}.${secret}`;
}

/** True for the opaque session format (exactly two non-empty segments). Legacy JWTs have three. */
export function isOpaqueRefreshToken(token: string): boolean {
  const parts = token.split('.');
  return parts.length === 2 && parts[0].length > 0 && parts[1].length > 0;
}

/** Split an opaque refresh token into `{ sid, secret }`, or null if it is not the opaque form. */
export function parseRefreshToken(token: string): { sid: string; secret: string } | null {
  if (!isOpaqueRefreshToken(token)) return null;
  const [sid, secret] = token.split('.');
  return { sid, secret };
}
