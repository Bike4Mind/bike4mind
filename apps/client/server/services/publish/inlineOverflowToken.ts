import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { Config } from '@bike4mind/server-utils/utils/config';

// Per-asset capability token for gated-bundle media that missed the inline budget
// (see collectInlineAssets). The serve route points the `<img>`/`<video>` at
// `{urlBase}/{path}?ot=<token>`; the opaque-origin iframe sends no credential, so the
// token alone authorizes that ONE file of that ONE artifact. Audience-scoped like
// publishGateToken, so a gate proof can't be replayed here or vice versa.
const OVERFLOW_TOKEN_AUDIENCE = 'publish-inline-overflow';

/** 1h: lazy-loaded images below the fold must still load after a slow read. */
export const OVERFLOW_TOKEN_TTL_SECONDS = 60 * 60;

const OverflowClaimsSchema = z.object({
  publicId: z.string().min(1),
  path: z.string().min(1),
});

export type OverflowTokenClaims = z.infer<typeof OverflowClaimsSchema>;

export function signOverflowAssetToken(claims: OverflowTokenClaims): string {
  return jwt.sign(OverflowClaimsSchema.parse(claims), Config.JWT_SECRET, {
    audience: OVERFLOW_TOKEN_AUDIENCE,
    expiresIn: OVERFLOW_TOKEN_TTL_SECONDS,
  });
}

/** True only when the token is valid, unexpired, and pinned to exactly this artifact and path. Never throws. */
export function verifyOverflowAssetToken(token: string, publicId: string, path: string): boolean {
  try {
    const decoded = jwt.verify(token, Config.JWT_SECRET, { audience: OVERFLOW_TOKEN_AUDIENCE });
    const claims = OverflowClaimsSchema.parse(decoded);
    return claims.publicId === publicId && claims.path === path;
  } catch {
    return false;
  }
}
