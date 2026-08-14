import { Logger } from '@bike4mind/observability';
import { IAuthSessionDocument, IAuthSessionRepository, IUserDocument, IUserRepository } from '@bike4mind/common';
import { UnauthorizedError } from '@bike4mind/utils';
import { REFRESH_REPLAY_WINDOW_MS } from './constants';
import { buildRefreshToken, generateRefreshSecret, hashRefreshSecret, parseRefreshToken } from './refreshTokenFormat';

export interface RotateSessionAdapters {
  db: {
    authSessions: Pick<IAuthSessionRepository, 'findBySid' | 'rotateHash' | 'touchLastUsed' | 'revokeBySid'>;
    users: Pick<IUserRepository, 'findById'>;
  };
  signAccessToken: (id: string, tokenVersion: number, additionalPayload?: Record<string, unknown>) => string;
  /** Replay tolerance for the just-superseded secret; defaults to REFRESH_REPLAY_WINDOW_MS. */
  replayWindowMs?: number;
  logger?: Logger;
}

interface RotateSessionResultBase {
  userId: string;
  user: IUserDocument;
  sid: string;
  accessToken: string;
  /** Admin id when this session was created by loginAs; null otherwise. Surfaced so the refresh
   *  endpoint can tell the client it is still inside an impersonation without decoding the JWT. */
  impersonatedBy: string | null;
}

/**
 * Two outcomes, deliberately modelled as a union so no call site can forget the second one:
 * `coalesced` carries NO refresh token, and a caller that blindly persisted `result.refreshToken`
 * would wipe the client's credential.
 *
 * - `rotated`   - this call advanced the chain. Hand the enclosed refresh token to the client.
 * - `coalesced` - a concurrent sibling advanced the chain first. The client's existing refresh
 *                 token must be left exactly as it is: do not set a cookie, do not return one,
 *                 do not clear one.
 */
export type RotateSessionResult =
  | (RotateSessionResultBase & { status: 'rotated'; refreshToken: string })
  | (RotateSessionResultBase & { status: 'coalesced' });

const invalid = () => new UnauthorizedError('Invalid refresh token');

/** Live == present, not revoked, not past its expiry. */
const isLive = (session: IAuthSessionDocument | null, now: Date): session is IAuthSessionDocument =>
  !!session && !session.revokedAt && session.expiresAt > now;

/** True when `hash` is the one-generation-back secret and its replay window is still open. */
const isReplayable = (session: IAuthSessionDocument, hash: string, now: Date): boolean =>
  !!session.previousRefreshTokenHash &&
  hash === session.previousRefreshTokenHash &&
  !!session.graceExpiresAt &&
  session.graceExpiresAt > now;

/**
 * Exchange an opaque `<sid>.<secret>` refresh token for a fresh access token, rotating the session's
 * stored secret when this caller is the one that advances the chain.
 *
 * The invariant this upholds: AT MOST ONE refresh token exists per session generation, and the
 * server never hands out a token that is not the row's current one. That matters because a browser
 * has a single cookie jar shared by every tab, so two tokens minted for one generation cannot both
 * survive - one is silently overwritten, and its holder later presents a secret the row no longer
 * knows. Reuse detection then revokes a perfectly healthy session. Enforcing the invariant removes
 * that failure mode at the source rather than trying to widen a window around it.
 *
 * Three cases:
 *  1. Presented secret is the current one -> compare-and-swap rotate. The winner gets a new token.
 *  2. The CAS lost, or the secret is the previous one inside the replay window -> a sibling already
 *     rotated. Return an access token and NOTHING else (`coalesced`). Critically this does not
 *     rotate: leaving `previous` pinned for the whole burst is what lets N concurrent siblings all
 *     resolve instead of chaining each other out of the window.
 *  3. Anything else -> an already-rotated or forged token was replayed. Treated as theft: the
 *     session is revoked and the caller rejected.
 *
 * Callers pass ONLY opaque tokens here; legacy JWT refresh tokens are handled + lazily migrated at
 * the endpoint (which then calls issueSession). Throws UnauthorizedError for any invalid/expired/
 * revoked/reused token.
 */
export const rotateSession = async (
  opaqueToken: string,
  { db, signAccessToken, replayWindowMs = REFRESH_REPLAY_WINDOW_MS, logger }: RotateSessionAdapters
): Promise<RotateSessionResult> => {
  const parsed = parseRefreshToken(opaqueToken);
  if (!parsed) throw invalid();
  const { sid, secret } = parsed;
  const presentedHash = hashRefreshSecret(secret);

  const session = await db.authSessions.findBySid(sid);
  const now = new Date();
  if (!isLive(session, now)) throw invalid();

  const revokeAsTheft = async (): Promise<never> => {
    // An already-rotated (or forged) token was replayed outside the replay window. Revoke the whole
    // session: if it is theft the attacker is locked out; if it is a benign client that fell outside
    // the window it re-authenticates.
    await db.authSessions.revokeBySid(sid);
    logger?.log('Refresh-token reuse detected; revoked session', sid);
    throw invalid();
  };

  const finish = async (rotatedSecret: string | null): Promise<RotateSessionResult> => {
    const user = await db.users.findById(session.userId);
    if (!user) throw invalid();

    const accessToken = signAccessToken(user.id, user.tokenVersion ?? 0, {
      sid,
      ...(session.impersonatedBy ? { impersonatedBy: session.impersonatedBy } : {}),
    });
    const base: RotateSessionResultBase = {
      userId: user.id,
      user,
      sid,
      accessToken,
      impersonatedBy: session.impersonatedBy ?? null,
    };

    if (rotatedSecret === null) {
      // No rotation happened, so nothing bumped lastUsedAt - but this is still real session
      // activity and the active-sessions UI reads that field as "last active".
      await db.authSessions.touchLastUsed(sid);
      return { ...base, status: 'coalesced' };
    }
    return { ...base, status: 'rotated', refreshToken: buildRefreshToken(sid, rotatedSecret) };
  };

  // Case 2a: already one generation behind, inside the window. A sibling rotated; do not fork the
  // chain behind it.
  if (presentedHash !== session.refreshTokenHash) {
    if (!isReplayable(session, presentedHash, now)) return revokeAsTheft();
    return finish(null);
  }

  const nextSecret = generateRefreshSecret();
  const updated = await db.authSessions.rotateHash(sid, {
    expectedCurrentHash: presentedHash,
    nextHash: hashRefreshSecret(nextSecret),
    replayExpiresAt: new Date(now.getTime() + replayWindowMs),
  });
  if (updated) return finish(nextSecret);

  // The CAS did not apply. Re-read to tell a lost race apart from a session that died underneath us:
  // both surface as a null update, but only one of them is recoverable.
  const current = await db.authSessions.findBySid(sid);
  const after = new Date();
  if (!isLive(current, after)) throw invalid();
  // Case 2b: a sibling rotated between our read and our write, so the secret we presented is now
  // the previous one. Same handling as 2a - it was valid a moment ago and the client cannot have
  // seen the winner's token yet.
  if (!isReplayable(current, presentedHash, after)) return revokeAsTheft();
  return finish(null);
};
