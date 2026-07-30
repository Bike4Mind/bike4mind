import { Logger } from '@bike4mind/observability';
import { IAuthSessionRepository, IUserDocument, IUserRepository } from '@bike4mind/common';
import { UnauthorizedError } from '@bike4mind/utils';
import { DEFAULT_GRACE_WINDOW_MS } from './constants';
import { buildRefreshToken, generateRefreshSecret, hashRefreshSecret, parseRefreshToken } from './refreshTokenFormat';

export interface RotateSessionAdapters {
  db: {
    authSessions: Pick<IAuthSessionRepository, 'findBySid' | 'rotateHash' | 'revokeBySid'>;
    users: Pick<IUserRepository, 'findById'>;
  };
  signAccessToken: (id: string, tokenVersion: number, additionalPayload?: Record<string, unknown>) => string;
  /** Grace window for the just-superseded hash; defaults to DEFAULT_GRACE_WINDOW_MS. */
  graceWindowMs?: number;
  logger?: Logger;
}

export interface RotatedSession {
  userId: string;
  user: IUserDocument;
  sid: string;
  accessToken: string;
  refreshToken: string;
}

/**
 * Exchange an opaque `<sid>.<secret>` refresh token for a fresh access + refresh pair, rotating the
 * session's stored secret.
 *
 * Reuse detection: a presented secret must hash to the session's CURRENT hash, or (within the grace
 * window) its PREVIOUS hash. Anything else means an already-rotated token was replayed -- treated as
 * theft: the session is revoked and the caller rejected. On a valid rotation the presented hash
 * becomes the new `previous` (anchored to what live clients hold) and a new secret becomes current.
 *
 * Callers pass ONLY opaque tokens here; legacy JWT refresh tokens are handled + lazily migrated at
 * the endpoint (which then calls issueSession). Throws UnauthorizedError for any invalid/expired/
 * revoked/reused token.
 */
export const rotateSession = async (
  opaqueToken: string,
  { db, signAccessToken, graceWindowMs = DEFAULT_GRACE_WINDOW_MS, logger }: RotateSessionAdapters
): Promise<RotatedSession> => {
  const parsed = parseRefreshToken(opaqueToken);
  if (!parsed) throw new UnauthorizedError('Invalid refresh token');
  const { sid, secret } = parsed;

  const session = await db.authSessions.findBySid(sid);
  const now = new Date();
  if (!session || session.revokedAt || session.expiresAt <= now) {
    throw new UnauthorizedError('Invalid refresh token');
  }

  const presentedHash = hashRefreshSecret(secret);
  const matchesCurrent = presentedHash === session.refreshTokenHash;
  const matchesPreviousInGrace =
    !!session.previousRefreshTokenHash &&
    presentedHash === session.previousRefreshTokenHash &&
    !!session.graceExpiresAt &&
    session.graceExpiresAt > now;

  if (!matchesCurrent && !matchesPreviousInGrace) {
    // An already-rotated (or forged) token was replayed. Revoke the whole session: if it is theft
    // the attacker is locked out; if it is a benign client that fell outside the grace window it
    // re-authenticates. Cross-tab token propagation (epic #1187) keeps live tabs converged so this
    // fires on genuine reuse, not routine multi-tab activity.
    await db.authSessions.revokeBySid(sid);
    logger?.log('Refresh-token reuse detected; revoked session', sid);
    throw new UnauthorizedError('Invalid refresh token');
  }

  const user = await db.users.findById(session.userId);
  if (!user) throw new UnauthorizedError('Invalid refresh token');

  const nextSecret = generateRefreshSecret();
  const graceExpiresAt = new Date(now.getTime() + graceWindowMs);
  // previous := the hash the caller presented, so a sibling still holding that same secret stays
  // valid inside the refreshed window.
  const updated = await db.authSessions.rotateHash(sid, hashRefreshSecret(nextSecret), presentedHash, graceExpiresAt);
  if (!updated) throw new UnauthorizedError('Invalid refresh token'); // raced revoke/expiry

  const accessToken = signAccessToken(user.id, user.tokenVersion ?? 0, {
    sid,
    ...(session.impersonatedBy ? { impersonatedBy: session.impersonatedBy } : {}),
  });

  return { userId: user.id, user, sid, accessToken, refreshToken: buildRefreshToken(sid, nextSecret) };
};
