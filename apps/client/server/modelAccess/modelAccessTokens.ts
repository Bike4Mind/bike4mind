import { createHash, createHmac, hkdfSync, timingSafeEqual } from 'crypto';
import { Config } from '@bike4mind/server-utils/utils/config';

/**
 * Tokens the bulk access endpoint hands out and takes back: `<payload>.<mac>`, both base64url, the MAC an
 * HMAC-SHA256 over the payload text. Only this server reads them, so an HMAC is enough. The key is derived
 * from JWT_SECRET with HKDF under its own label (as apps/client/server/analytics/hopToken.ts and
 * signupBotChecks.ts derive theirs), so self-host needs no new secret and no other token verifies here.
 */

const KEY_LABEL = 'b4m-model-access-bulk-token/v1';

/** How long a dry run or an undo stays redeemable. */
export const ACCESS_TOKEN_TTL_MS = 10 * 60_000;

let key: Buffer | undefined;
const tokenKey = (): Buffer => (key ??= Buffer.from(hkdfSync('sha256', Config.JWT_SECRET, '', KEY_LABEL, 32)));

const mac = (body: string) => createHmac('sha256', tokenKey()).update(body).digest('base64url');

export function signAccessToken(payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${mac(body)}`;
}

/** The payload of a token this server signed, or null for anything else. Expiry is the caller's check. */
export function readAccessToken(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, given] = parts;
  const expected = Buffer.from(mac(body));
  const actual = Buffer.from(given);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  try {
    const payload: unknown = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return typeof payload === 'object' && payload !== null && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Key-sorted JSON, so two spellings of one change or selection bind the same token. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([name, item]) => `${JSON.stringify(name)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Digest of the sorted id-to-stamp list (null for an id with no entry) a dry run was computed from. */
export const stampsDigest = (stamps: [string, string | null][]): string =>
  createHash('sha256').update(JSON.stringify(stamps)).digest('base64url');
