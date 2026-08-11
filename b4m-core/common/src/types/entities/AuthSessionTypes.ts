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
 * Rotation grace: on rotation the prior hash moves to `previousRefreshTokenHash` and stays valid
 * until `graceExpiresAt`, so a concurrent client that presents the just-rotated token inside the
 * window is served a fresh token instead of being flagged as reuse. A token matching neither the
 * current nor the (in-window) previous hash is treated as theft and revokes the session. Full
 * multi-tab convergence is completed by the cross-tab token propagation in the cookie-storage work
 * (see epic #1187); this window handles the common near-simultaneous case on its own.
 */
export interface IAuthSession {
  /** Stable session id, embedded as `sid` in the access + refresh tokens. */
  sid: string;
  userId: string;
  /** sha256 of the current refresh secret. Rotated on every refresh. */
  refreshTokenHash: string;
  /** Prior refresh hash, honored until `graceExpiresAt`; null once the window passes. */
  previousRefreshTokenHash?: string | null;
  /** Absolute time the grace window for `previousRefreshTokenHash` closes. */
  graceExpiresAt?: Date | null;
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

export interface IAuthSessionRepository extends IBaseRepository<IAuthSessionDocument> {
  findBySid: (sid: string) => Promise<IAuthSessionDocument | null>;
  /** Active == not revoked and not yet expired. Backs the active-sessions UI. */
  findActiveByUserId: (userId: string) => Promise<IAuthSessionDocument[]>;
  /**
   * Atomically rotate a session's stored hash: set the new current hash, move the presented hash
   * into the grace slot, stamp the grace expiry, and bump lastUsedAt. Scoped to a non-revoked,
   * unexpired session. Returns the updated doc, or null if no such session exists.
   */
  rotateHash: (
    sid: string,
    nextHash: string,
    previousHash: string,
    graceExpiresAt: Date
  ) => Promise<IAuthSessionDocument | null>;
  /** Revoke a single session (this-device logout / reuse detection). Returns the doc, or null. */
  revokeBySid: (sid: string) => Promise<IAuthSessionDocument | null>;
  /** Revoke every active session for a user ("log out all devices"); `exceptSid` keeps one alive.
   *  Returns the number of sessions revoked. */
  revokeAllByUserId: (userId: string, options?: { exceptSid?: string }) => Promise<number>;
}
