import jwt from 'jsonwebtoken';
import { z } from 'zod';
import type { Request, Response } from 'express';
import { Config } from '@server/utils/config';

// Publish access-gate proof token (passphrase mode).
//
// On correct passphrase, POST /api/publish/gate/passphrase mints this short-lived
// signed JWT as an HttpOnly cookie scoped to that ONE artifact; the serve route
// verifies it and passes `passphraseVerified` into checkVisibility. The proof -
// not the passphrase - is what travels on requests, so the passphrase itself is
// never stored client-side.
//
// Audience-scoping (same pattern as voiceSessionToken): a leaked proof token can't
// be replayed against any other JWT-accepting route, and the embedded publicId
// pins it to a single artifact - a proof for artifact A grants nothing on B.
const GATE_TOKEN_AUDIENCE = 'publish-passphrase-gate';

/** 2h: long enough to read/share around a meeting, short enough that rotating
 *  the passphrase (which does NOT invalidate outstanding proofs) has a bounded
 *  exposure window. */
export const GATE_TOKEN_TTL_SECONDS = 2 * 60 * 60;

const GateTokenClaimsSchema = z.object({
  publicId: z.string().min(1),
});

export type GateTokenClaims = z.infer<typeof GateTokenClaimsSchema>;

/** publicIds are URL-safe; enforce that before using one in a cookie name. */
const SAFE_PUBLIC_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function gateCookieName(publicId: string): string | null {
  if (!SAFE_PUBLIC_ID.test(publicId)) return null;
  return `b4m_pg_${publicId}`;
}

export function signGateToken(claims: GateTokenClaims): string {
  const payload = GateTokenClaimsSchema.parse(claims);
  return jwt.sign(payload, Config.JWT_SECRET, {
    audience: GATE_TOKEN_AUDIENCE,
    expiresIn: GATE_TOKEN_TTL_SECONDS,
  });
}

/** Verify a proof token; returns claims or null (never throws - an invalid or
 *  expired proof simply means "not verified" and the viewer re-prompts). */
export function verifyGateToken(token: string): GateTokenClaims | null {
  try {
    const decoded = jwt.verify(token, Config.JWT_SECRET, { audience: GATE_TOKEN_AUDIENCE });
    return GateTokenClaimsSchema.parse(decoded);
  } catch {
    return null;
  }
}

/** Minimal cookie-header parser (same pattern as analyticsMiddleware). */
function cookieFromHeader(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/** True when the request carries a valid passphrase proof for THIS artifact. */
export function requestHasGateProof(req: Request, publicId: string): boolean {
  const name = gateCookieName(publicId);
  if (!name) return false;
  const raw = cookieFromHeader(req.headers.cookie, name);
  if (!raw) return false;
  const claims = verifyGateToken(raw);
  return claims !== null && claims.publicId === publicId;
}

/** Set the proof cookie. SameSite=Lax so it rides top-level navigations to
 *  `/p/...` after the prompt page reloads; HttpOnly so bundle JS can't read it
 *  (the sandboxed iframe is opaque-origin anyway, belt and suspenders). */
export function setGateProofCookie(res: Response, publicId: string): boolean {
  const name = gateCookieName(publicId);
  if (!name) return false;
  const token = signGateToken({ publicId });
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  const cookie = `${name}=${token}; Path=/; Max-Age=${GATE_TOKEN_TTL_SECONDS}; HttpOnly; SameSite=Lax${secure}`;
  // Append rather than overwrite: `res.setHeader('Set-Cookie', string)` replaces
  // any Set-Cookie already on the response (Node treats a string value as the
  // whole header), so coexist with other cookies by preserving prior values.
  const existing = res.getHeader('Set-Cookie');
  const next = existing
    ? Array.isArray(existing)
      ? [...existing.map(String), cookie]
      : [String(existing), cookie]
    : cookie;
  res.setHeader('Set-Cookie', next);
  return true;
}
