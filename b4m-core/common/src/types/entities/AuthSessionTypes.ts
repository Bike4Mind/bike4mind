import { IBaseRepository } from './BaseTypes';
import { IMongoDocument } from './common';

/** How a session was created -- surfaced in the active-sessions UI and the auth audit log. */
export type AuthSessionCreatedVia =
  | 'otc'
  | 'otc-registration'
  | 'mfa'
  | 'mfa-setup'
  | 'oauth'
  | 'okta'
  | 'saml'
  | 'impersonation'
  | 'emergency'
  | 'identify'
  | 'oauth-token'
  | 'device'
  | 'legacy-migration';

/** Device/agent metadata captured at session creation, for the active-sessions list. */
export interface IAuthSessionDevice {
  userAgent?: string;
  browser?: string;
  os?: string;
  ip?: string;
  location?: string;
}

/**
 * One authenticated session == one issued refresh token. The refresh token is the unit of
 * revocation: per-session, individually revocable, and rotated on every refresh. Only a hash of
 * the refresh secret is stored, never the raw token.
 *
 * Replay window: on rotation the prior hash moves to `previousRefreshTokenHash` and stays
 * REPLAYABLE until `graceExpiresAt`. Presenting it there yields an access token ONLY - it does not
 * rotate and issues no refresh token, so the chain cannot fork during a concurrent-sibling burst.
 * Presenting it AFTER the window means the successor's response never reached the client (responses
 * land in seconds or never), so the chain is rotated forward from the previous hash instead
 * (recovery), capped by `recoveries` because one lost response needs exactly one recovery. Only a
 * token matching neither the current nor the previous hash is treated as theft and revokes the
 * session. See rotateSession in @bike4mind/services for the full rule set.
 */
export interface IAuthSession {
  /** Stable session id, embedded as `sid` in the access + refresh tokens. */
  sid: string;
  userId: string;
  /** sha256 of the current refresh secret. Rotated on every refresh. */
  refreshTokenHash: string;
  /** Prior refresh hash, replayable until `graceExpiresAt`; null once the window passes. */
  previousRefreshTokenHash?: string | null;
  /** Absolute time the replay window for `previousRefreshTokenHash` closes. */
  graceExpiresAt?: Date | null;
  /** Replays of `previousRefreshTokenHash` served in the current generation. Capped so the window
   *  bounds the NUMBER of access tokens a superseded secret can mint, not just their timespan.
   *  Reset to 0 on every rotation. Absent on rows written before this field existed. */
  replayUses?: number;
  /** Recoveries served since the last true rotation (see recoverRotateHash). A genuine lost
   *  response needs exactly ONE, so a cap here is what stops a superseded secret from being a
   *  renewable credential: without it, `previousRefreshTokenHash` stays pinned across recoveries
   *  and the same secret recovers the chain again every time the grace window lapses. Reset to 0
   *  by rotateHash - advancing the chain from the CURRENT secret proves the client is live.
   *  Absent on rows written before this field existed. */
  recoveries?: number;
  device?: IAuthSessionDevice;
  createdVia: AuthSessionCreatedVia;
  /** Set when this session belongs to an admin impersonating the user (loginAs). */
  impersonatedBy?: string | null;
  lastUsedAt: Date;
  /** TTL: the session (and its row) expire here; mirrors the refresh-token TTL. */
  expiresAt: Date;
  /** Set when revoked (logout, reuse detection, admin force-logout). */
  revokedAt?: Date | null;
}

export interface IAuthSessionDocument extends IAuthSession, IMongoDocument {}

/**
 * Client-safe projection of an AuthSession for the active-sessions UI (GET /api/users/me/sessions).
 * Deliberately omits every secret (`refreshTokenHash`, `previousRefreshTokenHash`) - only fields a
 * user may see about their own devices. Dates are ISO strings (JSON transport). `current` flags the
 * session making the request so the UI can label "This device" and hide its self-revoke button.
 */
export interface IActiveSessionDto {
  sid: string;
  createdVia: AuthSessionCreatedVia;
  device?: IAuthSessionDevice;
  /** Last time this session refreshed its token - approximates "last active". ISO string. */
  lastUsedAt: string;
  /** When the session was created (sign-in time). ISO string. */
  createdAt: string;
  /** When the session (and its refresh cookie) expires. ISO string. */
  expiresAt: string;
  /** True when this session was created by an admin impersonating the user. */
  impersonated: boolean;
  /** True for the session that issued the current request. */
  current: boolean;
}

export interface IAuthSessionRepository extends IBaseRepository<IAuthSessionDocument> {
  findBySid: (sid: string) => Promise<IAuthSessionDocument | null>;
  /** Active == not revoked and not yet expired. Backs the active-sessions UI. */
  findActiveByUserId: (userId: string) => Promise<IAuthSessionDocument[]>;
  /**
   * Compare-and-swap a session's refresh hash: advance `expectedCurrentHash` to `nextHash`, move
   * the superseded hash into the replay slot, stamp its expiry, and bump lastUsedAt.
   *
   * The CAS on `expectedCurrentHash` is load-bearing, not defensive. Two concurrent refreshes that
   * both read the same current hash would otherwise both "succeed" and mint two valid refresh
   * tokens for one session - but a browser has a single cookie jar, so only one survives and the
   * other is silently lost. The stranded client then presents a secret the row no longer knows and
   * trips reuse detection, revoking a healthy session. The CAS makes at most one rotation win per
   * generation, so exactly one refresh token can exist and there is nothing to strand.
   *
   * `newExpiresAt` slides the session expiry forward with this use (computed by the caller, which
   * holds the row's createdAt for the absolute cap; see rotateSession). It is REQUIRED here and
   * absent from recoverRotateHash on purpose: advancing the chain from the CURRENT secret proves a
   * live client and earns a slide, whereas a recovery is driven by a superseded secret and must
   * never extend the session's life. Making that a signature rather than a convention is what
   * stops a copy-paste from quietly handing an attacker a renewable, self-extending credential.
   * Also resets `recoveries` - see that field.
   *
   * Returns the updated doc, or null when the swap did not apply - either the session is
   * revoked/expired, or a concurrent rotation won. Callers must re-read to tell those apart; see
   * rotateSession in @bike4mind/services.
   */
  rotateHash: (
    sid: string,
    params: { expectedCurrentHash: string; nextHash: string; replayExpiresAt: Date; newExpiresAt: Date }
  ) => Promise<IAuthSessionDocument | null>;
  /**
   * Compare-and-swap recovery rotation: advance the chain FROM the previous hash, for a client
   * whose last rotation response never arrived (it still presents the superseded secret after the
   * coalesce window closed). Discards the never-delivered current hash.
   *
   * The CAS is `previousRefreshTokenHash == expectedPreviousHash AND graceExpiresAt <= now AND
   * recoveries < maxRecoveries`: the winner re-opens graceExpiresAt, so a concurrent second
   * recovery fails the `$lte` clause and falls back to a coalesce inside the fresh window.
   * `previousRefreshTokenHash` is deliberately left pinned to the presented hash for the same
   * reason rotateHash pins it: siblings still holding it must coalesce, not fork the chain.
   *
   * That pinning is exactly why `maxRecoveries` exists. Because the presented hash stays in the
   * previous slot, the same secret satisfies this filter again every time the grace window lapses
   * - so without a cap one superseded secret is replayable forever rather than once. One lost
   * response needs ONE recovery; the counter is reset only by rotateHash, i.e. by proving
   * possession of the current secret. Note this method takes no `newExpiresAt`: recoveries never
   * slide the session (see rotateHash).
   *
   * Returns the updated doc, or null when the swap did not apply (dead session, hash mismatch,
   * allowance spent, or a concurrent recovery won). Callers re-read to distinguish; see
   * rotateSession.
   */
  recoverRotateHash: (
    sid: string,
    params: { expectedPreviousHash: string; nextHash: string; replayExpiresAt: Date; maxRecoveries: number }
  ) => Promise<IAuthSessionDocument | null>;
  /**
   * Atomically claim one unit of the superseded secret's replay allowance, bumping lastUsedAt with
   * it (a refresh served without a rotation is still real session activity, so the active-sessions
   * UI must not show it as idle).
   *
   * Returns the updated doc, or null when the allowance is spent OR the session is no longer live -
   * both mean "do not serve this", so callers need not distinguish them. Scoped to a live row, like
   * rotateHash.
   */
  registerReplayUse: (sid: string, maxUses: number) => Promise<IAuthSessionDocument | null>;
  /** Revoke a single session (this-device logout / reuse detection). Returns the doc, or null. */
  revokeBySid: (sid: string) => Promise<IAuthSessionDocument | null>;
  /** Revoke every active session for a user ("log out all devices"); `exceptSid` keeps one alive.
   *  Returns the number of sessions revoked. */
  revokeAllByUserId: (userId: string, options?: { exceptSid?: string }) => Promise<number>;
}
