import { createHmac, timingSafeEqual } from 'node:crypto';
import { requireConfiguredSecret } from '@bike4mind/common';
import { z } from 'zod';
import { Resource } from 'sst';

/**
 * Capability token carried by self-host generated-media proxy URLs: `<payload>.<mac>`, both
 * base64url, where the payload is `{k: key, e: expiry}` and the mac is HMAC-SHA256 over the payload
 * text. Minting one is the read grant, so only call sites that already authorized the key sign.
 * Every verification failure collapses to `false` so a caller cannot answer differently per cause.
 */

export const MAX_GENERATED_MEDIA_URL_TOKEN_LENGTH = 2048;

const ClaimsSchema = z.object({
  k: z.string().min(1).max(1024),
  e: z.number().int().positive(),
});

const PART_SHAPE = /^[A-Za-z0-9_-]+$/;
const MAC_SHAPE = /^[A-Za-z0-9_-]{43}$/;

// Its own key derived from the JWT secret, so this token can never verify as an auth JWT or a
// file-link token (see files/fileLinkToken.ts) and vice versa.
let cachedKey: Buffer | undefined;
const tokenKey = () =>
  (cachedKey ??= createHmac('sha256', requireConfiguredSecret('JWT_SECRET', Resource.JWT_SECRET.value))
    .update('b4m-generated-media-url/v1')
    .digest());

const mac = (key: Buffer, payload: string) => createHmac('sha256', key).update(payload).digest('base64url');

export function signGeneratedMediaUrlToken(claims: { key: string; exp: number }, key: Buffer = tokenKey()): string {
  const payload = Buffer.from(JSON.stringify({ k: claims.key, e: claims.exp })).toString('base64url');
  return `${payload}.${mac(key, payload)}`;
}

/** True only for an untampered, unexpired token minted for exactly `requestedKey`. */
export function verifyGeneratedMediaUrlToken(
  token: unknown,
  requestedKey: string,
  nowSeconds: number,
  key: Buffer = tokenKey()
): boolean {
  if (typeof token !== 'string' || token.length > MAX_GENERATED_MEDIA_URL_TOKEN_LENGTH) return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [payload, given] = parts;
  if (!PART_SHAPE.test(payload) || !MAC_SHAPE.test(given)) return false;
  if (!timingSafeEqual(Buffer.from(mac(key, payload)), Buffer.from(given))) return false;

  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return false;
  }
  const parsed = ClaimsSchema.safeParse(raw);
  if (!parsed.success) return false;
  return parsed.data.k === requestedKey && nowSeconds < parsed.data.e;
}
