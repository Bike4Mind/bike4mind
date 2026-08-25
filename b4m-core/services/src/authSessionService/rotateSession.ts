import { Logger } from '@bike4mind/observability';
import { IAuthSessionDocument, IAuthSessionRepository, IUserDocument, IUserRepository } from '@bike4mind/common';
import { TooManyRequestsError, UnauthorizedError } from '@bike4mind/utils';
import {
  ABSOLUTE_SESSION_MAX_MS,
  DEFAULT_REFRESH_TTL_MS,
  MAX_REFRESH_REPLAY_USES,
  REFRESH_REPLAY_WINDOW_MS,
} from './constants';
import { buildRefreshToken, generateRefreshSecret, hashRefreshSecret, parseRefreshToken } from './refreshTokenFormat';

/**
 * Involuntary session events worth a forensic trail. The `type` values are deliberately valid
 * UserAuthAuditEvent names so the refresh endpoint can pass them straight to logAuthAudit.
 */
export interface RotateSessionAuditEvent {
  type: 'session_reuse_revoked' | 'session_recovered' | 'refresh_replay_capped';
  sid: string;
  userId: string;
}

export interface RotateSessionAdapters {
  db: {
    authSessions: Pick<
      IAuthSessionRepository,
      'findBySid' | 'rotateHash' | 'recoverRotateHash' | 'registerReplayUse' | 'revokeBySid'
    >;
    users: Pick<IUserRepository, 'findById'>;
  };
  signAccessToken: (id: string, tokenVersion: number, additionalPayload?: Record<string, unknown>) => string;
  /** Replay tolerance for the just-superseded secret; defaults to REFRESH_REPLAY_WINDOW_MS. */
  replayWindowMs?: number;
  /** How many replays of the superseded secret are served per generation; defaults to
   *  MAX_REFRESH_REPLAY_USES. */
  maxReplayUses?: number;
  /** Involuntary-session-event sink (see RotateSessionAuditEvent). Fire-and-forget: it is never
   *  awaited and a throw is swallowed, so it can never fail or slow the auth path. */
  audit?: (event: RotateSessionAuditEvent) => void;
  logger?: Logger;
}

/** Sentinel for "the allowance write could not be reached", which must not be conflated with the
 *  repository's `null` ("allowance spent / row not live"). The two demand opposite handling. */
const UNAVAILABLE = Symbol('replay-allowance-unavailable');

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
 * - `rotated`   - this call advanced the chain (a normal rotation OR a recovery). Hand the
 *                 enclosed refresh token to the client.
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

/** True when `hash` is the one-generation-back secret and its coalesce window is still open. */
const isReplayable = (session: IAuthSessionDocument, hash: string, now: Date): boolean =>
  !!session.previousRefreshTokenHash &&
  hash === session.previousRefreshTokenHash &&
  !!session.graceExpiresAt &&
  session.graceExpiresAt > now;

/**
 * Sliding session window: each rotation pushes expiry to now + the idle TTL, clamped to the
 * absolute cap (createdAt + ABSOLUTE_SESSION_MAX_MS) and never below what the row already
 * promised (monotone - a slide must not shorten a session).
 */
const slideExpiresAt = (session: IAuthSessionDocument, now: Date): Date => {
  const slid = now.getTime() + DEFAULT_REFRESH_TTL_MS;
  const cap = new Date(session.createdAt).getTime() + ABSOLUTE_SESSION_MAX_MS;
  return new Date(Math.max(new Date(session.expiresAt).getTime(), Math.min(slid, cap)));
};

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
 * Four cases:
 *  1. Presented secret is the current one -> compare-and-swap rotate. The winner gets a new token.
 *  2. The CAS lost, or the secret is the previous one inside the replay window -> a sibling already
 *     rotated. Return an access token and NOTHING else (`coalesced`). Critically this does not
 *     rotate: leaving `previous` pinned for the whole burst is what lets N concurrent siblings all
 *     resolve instead of chaining each other out of the window.
 *  3. The secret is the previous one AFTER the window -> the successor's response never reached the
 *     client (an in-flight response lands within seconds or never, and a delivered successor would
 *     be presented instead). Recovery: rotate forward FROM the previous secret via its own CAS,
 *     discarding the never-delivered current. The client gets a fresh token; the session lives.
 *     Cost, accepted deliberately: a thief holding the superseded secret can take the chain and
 *     work until the next collision with the real holder revokes the session - the same
 *     collision-detection timescale as before, in exchange for never killing a healthy session on
 *     a lost response. Every recovery is surfaced through `audit` so abuse is observable.
 *  4. Anything else -> an already-rotated or forged token was replayed. Treated as theft: the
 *     session is revoked and the caller rejected.
 *
 * Rotations (cases 1 and 3) also SLIDE the session expiry - see slideExpiresAt. Callers pass ONLY
 * opaque tokens here; legacy JWT refresh tokens are handled + lazily migrated at the endpoint
 * (which then calls issueSession). Throws UnauthorizedError for any invalid/expired/revoked/reused
 * token.
 */
export const rotateSession = async (
  opaqueToken: string,
  {
    db,
    signAccessToken,
    replayWindowMs = REFRESH_REPLAY_WINDOW_MS,
    maxReplayUses = MAX_REFRESH_REPLAY_USES,
    audit,
    logger,
  }: RotateSessionAdapters
): Promise<RotateSessionResult> => {
  const parsed = parseRefreshToken(opaqueToken);
  if (!parsed) throw invalid();
  const { sid, secret } = parsed;
  const presentedHash = hashRefreshSecret(secret);

  const session = await db.authSessions.findBySid(sid);
  const now = new Date();
  if (!isLive(session, now)) throw invalid();

  const emit = (type: RotateSessionAuditEvent['type']): void => {
    try {
      audit?.({ type, sid, userId: session.userId });
    } catch {
      // The audit sink must never fail or slow authentication.
    }
  };

  const revokeAsTheft = async (): Promise<never> => {
    // A token matching neither the current nor the previous hash was presented: forged, or at
    // least two generations stale. Revoke the whole session: if it is theft the attacker is
    // locked out; the (rare) benign holder of such a token re-authenticates.
    await db.authSessions.revokeBySid(sid);
    emit('session_reuse_revoked');
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
      // Claim one unit of the replay allowance. This both bounds how many access tokens a single
      // superseded secret can mint (the window is otherwise purely a duration) and bumps
      // lastUsedAt, which the rotated path gets for free inside its CAS write.
      //
      // A transport failure here must NOT fail the refresh: nothing about this exchange went
      // wrong, and N-1 of N concurrent siblings take this path during exactly the burst this
      // whole change exists to survive. So an ERROR is swallowed and we serve, while a definitive
      // `null` - allowance spent, or the row is no longer live - is honoured and rejected.
      const claimed = await db.authSessions.registerReplayUse(sid, maxReplayUses).catch(() => UNAVAILABLE);
      if (claimed === null) {
        // Deliberately NOT revokeAsTheft, and deliberately NOT UnauthorizedError. Overrunning the
        // cap is what an unusually large legitimate burst looks like too, so this must degrade to
        // "try again", not "your session is gone":
        //  - revoking would reintroduce the very "kill a healthy session" failure this change
        //    removes;
        //  - a 401 would too, one step later, because the client's 401 interceptor reads 400/401
        //    from the refresh endpoint as a revocation and tears the session down. 429 is in the
        //    transient bucket it already retries instead.
        emit('refresh_replay_capped');
        logger?.log('Refresh replay allowance exhausted for session', sid);
        throw new TooManyRequestsError('Too many refresh attempts');
      }
      return { ...base, status: 'coalesced' };
    }
    return { ...base, status: 'rotated', refreshToken: buildRefreshToken(sid, rotatedSecret) };
  };

  // Case 3: recovery. The presented secret is one generation back and its coalesce window has
  // closed, so the successor's response never made it to the client. Rotate forward from what the
  // client actually holds. The CAS (previous match + closed window, re-opened by the winner) makes
  // exactly one recovery win; losers fall through to a coalesce inside the fresh window.
  const recover = async (): Promise<RotateSessionResult> => {
    const nextSecret = generateRefreshSecret();
    const updated = await db.authSessions.recoverRotateHash(sid, {
      expectedPreviousHash: presentedHash,
      nextHash: hashRefreshSecret(nextSecret),
      replayExpiresAt: new Date(Date.now() + replayWindowMs),
      newExpiresAt: slideExpiresAt(session, now),
    });
    if (updated) {
      emit('session_recovered');
      logger?.log('Recovered session', sid, 'from a lost rotation response');
      return finish(nextSecret);
    }
    // The CAS did not apply. Re-read: a sibling's recovery re-opened the window for this same hash
    // (coalesce there), or the session died. Deliberately NOT recursing into recover() - one
    // recovery attempt per call keeps the failure modes finite.
    const current = await db.authSessions.findBySid(sid);
    const after = new Date();
    if (!isLive(current, after)) throw invalid();
    if (isReplayable(current, presentedHash, after)) return finish(null);
    return revokeAsTheft();
  };

  if (presentedHash !== session.refreshTokenHash) {
    // Not the previous hash either (or there is none): forged or 2+ generations stale -> theft.
    if (!session.previousRefreshTokenHash || presentedHash !== session.previousRefreshTokenHash) {
      return revokeAsTheft();
    }
    // Case 2a: one generation behind, inside the window. A sibling rotated; do not fork the chain.
    if (isReplayable(session, presentedHash, now)) return finish(null);
    return recover();
  }

  const nextSecret = generateRefreshSecret();
  const updated = await db.authSessions.rotateHash(sid, {
    expectedCurrentHash: presentedHash,
    nextHash: hashRefreshSecret(nextSecret),
    replayExpiresAt: new Date(now.getTime() + replayWindowMs),
    newExpiresAt: slideExpiresAt(session, now),
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
  if (isReplayable(current, presentedHash, after)) return finish(null);
  // Previous matches but the window already closed underneath us (this call slept past the whole
  // grace period mid-flight) - same lost-response semantics as the pre-CAS branch.
  if (presentedHash === current.previousRefreshTokenHash) return recover();
  return revokeAsTheft();
};
