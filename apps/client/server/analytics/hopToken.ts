import crypto from 'crypto';
import { Config } from '@bike4mind/server-utils/utils/config';

/**
 * The token a verified hop travels as: `<hopId>.<exp>.<mac>`.
 *
 * - `hopId`: the stored hop's id, 32 random hex characters.
 * - `exp`: when the token stops redeeming, in whole seconds since the epoch.
 * - `mac`: HMAC-SHA256 over the hop id, the expiry and the destination, base64url.
 *
 * An HMAC is enough because only this server ever verifies a token: nothing outside it needs to
 * check one, so there is no public half to publish. The destination is in the MAC but not in the
 * token, so a token verifies only where it was minted to land. The expiry is in the token so a
 * stale one is refused before the database is asked.
 */

/** How long a minted token redeems for. */
export const HOP_TOKEN_TTL_SECONDS = 10 * 60;

/** The longest token a beacon may carry. A real one is 87 characters. */
export const MAX_HOP_TOKEN_LENGTH = 128;

const HOP_ID_SHAPE = /^[0-9a-f]{32}$/;
const EXP_SHAPE = /^\d{1,12}$/;
const MAC_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/**
 * The label the hop key is derived under. Changing it rotates every hop key at once, which costs
 * only the tokens minted in the last ten minutes.
 */
const HOP_KEY_LABEL = 'b4m-hop-token-key/v1';

const NOT_CONFIGURED = 'not-configured';

/** A fresh hop id: 16 random bytes, hex. */
export function mintHopId(): string {
  return crypto.randomBytes(16).toString('hex');
}

export function isHopId(value: unknown): value is string {
  return typeof value === 'string' && HOP_ID_SHAPE.test(value);
}

/**
 * The hop key, derived from a server secret by HMAC under its own label (domain separation).
 *
 * Derived rather than held as a secret of its own so that hops need no new deployment secret. The
 * parent is the analytics pseudonym salt, which every deployment that reports to Overwatch already
 * holds, and without which no hop event could be sent anyway. The derived key cannot be turned
 * back into the salt, and no pseudonym can be turned into it: a pseudonym is the same HMAC over a
 * 24-character user id, never over this label.
 */
export function deriveHopKey(secret: string): Buffer {
  return crypto.createHmac('sha256', secret).update(HOP_KEY_LABEL).digest();
}

/** The configured hop key, or undefined when this deployment has no pseudonym salt. */
export function hopKey(): Buffer | undefined {
  const salt = Config.OVERWATCH_PSEUDONYM_SALT;
  return salt && salt !== NOT_CONFIGURED ? deriveHopKey(salt) : undefined;
}

function mac(key: Buffer, hopId: string, exp: number, dest: string): string {
  return crypto.createHmac('sha256', key).update(`${hopId}.${exp}.${dest}`).digest('base64url');
}

export function signHopToken(key: Buffer, hop: { hopId: string; exp: number; dest: string }): string {
  return `${hop.hopId}.${hop.exp}.${mac(key, hop.hopId, hop.exp, hop.dest)}`;
}

export type HopTokenCheck =
  { ok: true; hopId: string; exp: number } | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' };

/**
 * Check a token's shape, MAC and expiry for a destination. The MAC is checked before the expiry
 * and in constant time. A pass says only that this server minted the token for `dest` and that it
 * has not expired; whether it has been redeemed is the store's answer (analyticsHopRepository).
 */
export function verifyHopToken(key: Buffer, token: unknown, opts: { dest: string; nowSeconds: number }): HopTokenCheck {
  if (typeof token !== 'string') return { ok: false, reason: 'malformed' };
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };
  const [hopId, expRaw, given] = parts;
  if (!HOP_ID_SHAPE.test(hopId) || !EXP_SHAPE.test(expRaw) || !MAC_SHAPE.test(given)) {
    return { ok: false, reason: 'malformed' };
  }
  const exp = Number(expRaw);
  const expected = Buffer.from(mac(key, hopId, exp, opts.dest));
  if (!crypto.timingSafeEqual(expected, Buffer.from(given))) return { ok: false, reason: 'bad_signature' };
  if (opts.nowSeconds >= exp) return { ok: false, reason: 'expired' };
  return { ok: true, hopId, exp };
}
