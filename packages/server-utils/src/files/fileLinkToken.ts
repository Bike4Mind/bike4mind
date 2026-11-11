import { createHmac, timingSafeEqual } from 'node:crypto';
import { requireEnv } from '@bike4mind/common';
import { z } from 'zod';
import { Resource } from 'sst';

/**
 * A link to a stored file that can travel in an email or a Slack message: `<payload>.<mac>`, both
 * base64url, where the payload is the JSON claims below and the mac is HMAC-SHA256 over the
 * payload text. The token is the only credential such a link carries, so the redeeming route
 * (apps/client/pages/api/file-links/[token].ts) re-checks access and signs a short-lived URL on
 * every click.
 */

export const FILE_LINK_PATH = '/api/file-links';
/** Lifetime of the storage URL a redeemed link redirects to. */
export const FILE_LINK_REDIRECT_TTL_SECONDS = 15 * 60;
export const MAX_FILE_LINK_TOKEN_LENGTH = 4096;

export type FileLinkTarget =
  { kind: 'fabFile'; fileId: string } | { kind: 'filesKey'; key: string } | { kind: 'generatedKey'; key: string };

export type FileLinkClaims = { target: FileLinkTarget; userId: string; exp: number };

const ClaimsSchema = z.object({
  t: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('fabFile'), fileId: z.string().min(1).max(64) }),
    z.object({ kind: z.literal('filesKey'), key: z.string().min(1).max(1024) }),
    z.object({ kind: z.literal('generatedKey'), key: z.string().min(1).max(1024) }),
  ]),
  u: z.string().min(1).max(64),
  e: z.number().int().positive(),
});

const PART_SHAPE = /^[A-Za-z0-9_-]+$/;
const MAC_SHAPE = /^[A-Za-z0-9_-]{43}$/;

// Its own key derived from the JWT secret, so a link token can never verify as an auth JWT or vice versa.
let cachedKey: Buffer | undefined;
const fileLinkKey = () =>
  (cachedKey ??= createHmac('sha256', Resource.JWT_SECRET.value).update('b4m-file-link-token/v1').digest());

const mac = (key: Buffer, payload: string) => createHmac('sha256', key).update(payload).digest('base64url');

export function signFileLinkToken(claims: FileLinkClaims, key: Buffer = fileLinkKey()): string {
  const payload = Buffer.from(JSON.stringify({ t: claims.target, u: claims.userId, e: claims.exp })).toString(
    'base64url'
  );
  return `${payload}.${mac(key, payload)}`;
}

export type FileLinkTokenCheck = { ok: true; claims: FileLinkClaims } | { ok: false; reason: 'malformed' | 'expired' };

/** Signature is checked in constant time before the payload is parsed or the expiry read. */
export function verifyFileLinkToken(
  token: unknown,
  nowSeconds: number,
  key: Buffer = fileLinkKey()
): FileLinkTokenCheck {
  if (typeof token !== 'string' || token.length > MAX_FILE_LINK_TOKEN_LENGTH) return { ok: false, reason: 'malformed' };
  const parts = token.split('.');
  if (parts.length !== 2) return { ok: false, reason: 'malformed' };
  const [payload, given] = parts;
  if (!PART_SHAPE.test(payload) || !MAC_SHAPE.test(given)) return { ok: false, reason: 'malformed' };
  if (!timingSafeEqual(Buffer.from(mac(key, payload)), Buffer.from(given))) return { ok: false, reason: 'malformed' };

  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  const parsed = ClaimsSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: 'malformed' };
  if (nowSeconds >= parsed.data.e) return { ok: false, reason: 'expired' };
  return { ok: true, claims: { target: parsed.data.t, userId: parsed.data.u, exp: parsed.data.e } };
}

/** An absolute app URL that redeems to `target` for `userId` until `ttlSeconds` from now. */
export function buildFileLinkUrl(
  target: FileLinkTarget,
  userId: string,
  ttlSeconds: number,
  nowMs = Date.now()
): string {
  if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) throw new Error('file link TTL must be a positive integer');
  const exp = Math.floor(nowMs / 1000) + ttlSeconds;
  const baseUrl = requireEnv('APP_URL', process.env.APP_URL).replace(/\/+$/, '');
  return `${baseUrl}${FILE_LINK_PATH}/${signFileLinkToken({ target, userId, exp })}`;
}
