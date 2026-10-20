import { randomBytes } from 'crypto';
import { authSessionService } from '@bike4mind/services';
import { oauthRefreshTokenRepository } from '@bike4mind/database';

/**
 * Relying-party OAuth refresh tokens (grant_type=refresh_token at /api/oauth/token). Same
 * `<id>.<secret>` format and lifetimes as first-party sessions, but stored in their own family
 * collection (OAuthRefreshTokenModel) so the first-party refresh paths can never reach them.
 */

/** Slides to now + 30d on every rotation, never past the family's 90d hard cap. */
export function refreshFamilyExpiresAt(familyCreatedAt: Date, now = new Date()): Date {
  return new Date(
    Math.min(
      now.getTime() + authSessionService.DEFAULT_REFRESH_TTL_MS,
      familyCreatedAt.getTime() + authSessionService.ABSOLUTE_SESSION_MAX_MS
    )
  );
}

/** Start a new family and return its first refresh token. Only the secret's hash is stored. */
export async function mintRefreshFamily(params: {
  userId: string;
  clientId: string;
  scopes: string[];
  tokenVersion: number;
}): Promise<string> {
  // base64url has no '.', so the `<familyId>.<secret>` split stays unambiguous.
  const familyId = randomBytes(16).toString('base64url');
  const secret = authSessionService.generateRefreshSecret();
  const now = new Date();
  await oauthRefreshTokenRepository.create({
    ...params,
    familyId,
    tokenHash: authSessionService.hashRefreshSecret(secret),
    expiresAt: refreshFamilyExpiresAt(now, now),
  });
  return authSessionService.buildRefreshToken(familyId, secret);
}
