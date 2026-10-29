import type { Types } from 'mongoose';
import { User, UserAuthAuditLogModel, type UserAuthAuditEvent } from '@bike4mind/database';
import {
  SIGNUP_CLUSTER_WINDOW_DAYS,
  type AuditLogCursor,
  type ILoginRecord,
  type UserSignIn,
  type UserSignInResult,
  type UserSignupCluster,
} from '@bike4mind/common';
import { createdAtCursorClauses, type UserAuthAuditRow } from './userActivity';

const QUERY_MAX_TIME_MS = 15_000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** How far apart an auth audit row and a client login record may be and still describe one sign-in. */
const LOGIN_RECORD_MATCH_MS = 5 * 60 * 1000;
export const MAX_SIGNUP_CLUSTER_MATCHES = 20;

/** One plain-language line per auth audit event; `method` is the label of the row's strategy. */
export const authEventSummary = (event: UserAuthAuditEvent, method: string | undefined): string => {
  switch (event) {
    case 'login_success':
      return method ? `Signed in with ${method}` : 'Signed in';
    case 'logout':
      return 'Signed out';
    case 'password_reset':
      return 'Reset password';
    case 'mfa_enrolled':
      return 'Turned on two-factor authentication';
    case 'mfa_disabled':
      return 'Turned off two-factor authentication';
    case 'passkey_registered':
      return 'Added a passkey';
    case 'passkey_removed':
      return 'Removed a passkey';
    case 'oauth_link':
      return `Linked ${method ?? 'a sign-in provider'}`;
    case 'oauth_unlink':
      return `Unlinked ${method ?? 'a sign-in provider'}`;
    case 'session_revoked':
      return 'Session revoked';
    case 'session_reuse_revoked':
      return 'Blocked a reused session token and revoked the session';
    case 'session_recovered':
      return 'Session recovered';
    case 'refresh_replay_capped':
      return 'Blocked a repeated session refresh';
    case 'refresh_recovery_capped':
      return 'Blocked a session recovery over the limit';
    case 'trusted_device_granted':
      return 'Trusted a device';
    case 'trusted_device_used':
      return 'Skipped two-factor on a trusted device';
    case 'trusted_device_revoked':
      return 'Removed a trusted device';
    case 'oauth_grant_revoked':
      return 'Revoked an app connection';
    case 'oauth_refresh_reuse_revoked':
      return 'Blocked a reused app token and revoked the connection';
    case 'step_up_success':
      return 'Passed an identity check';
    case 'step_up_failed':
      return 'Failed an identity check';
    case 'email_change_requested':
      return 'Requested an email change';
    case 'email_change_confirmed':
      return 'Changed email address';
    case 'email_change_failed':
      return 'Failed to confirm an email change';
    case 'email_change_cancelled':
      return 'Cancelled an email change';
  }
};

/**
 * The auth audit events that are a sign-in attempt or a refused session, and how each one ended.
 * The audit has no failed-password or rate-limited sign-in event, so those cannot be shown yet.
 */
export const SIGN_IN_EVENT_RESULTS: Readonly<Partial<Record<UserAuthAuditEvent, UserSignInResult>>> = {
  login_success: 'success',
  step_up_failed: 'failed',
  session_reuse_revoked: 'blocked',
  refresh_replay_capped: 'blocked',
  refresh_recovery_capped: 'blocked',
  oauth_refresh_reuse_revoked: 'blocked',
};

const SIGN_IN_EVENTS = Object.keys(SIGN_IN_EVENT_RESULTS) as UserAuthAuditEvent[];

const BROWSERS: ReadonlyArray<[RegExp, string]> = [
  [/Edg\//, 'Edge'],
  [/OPR\/|Opera/, 'Opera'],
  [/Firefox\//, 'Firefox'],
  [/Chrome\/|CriOS\//, 'Chrome'],
  [/Safari\//, 'Safari'],
];

const OPERATING_SYSTEMS: ReadonlyArray<[RegExp, string]> = [
  [/iPhone|iPad|iPod/, 'iOS'],
  [/Android/, 'Android'],
  [/Windows/, 'Windows'],
  [/Mac OS X|Macintosh/, 'macOS'],
  [/CrOS/, 'ChromeOS'],
  [/Linux/, 'Linux'],
];

const firstMatch = (value: string, patterns: ReadonlyArray<[RegExp, string]>) =>
  patterns.find(([pattern]) => pattern.test(value))?.[1];

/** A coarse browser and OS read from a user agent, for rows with no client login record to match. */
export const describeUserAgent = (userAgent: string | undefined) =>
  userAgent
    ? { browser: firstMatch(userAgent, BROWSERS), operatingSystem: firstMatch(userAgent, OPERATING_SYSTEMS) }
    : {};

/** The client login record written for the same sign-in: closest in time within the window, same IP when both have one. */
export const matchLoginRecord = (
  at: Date,
  ip: string | undefined,
  records: readonly ILoginRecord[]
): ILoginRecord | undefined =>
  records
    .filter(record => {
      const distance = Math.abs(new Date(record.loginTime).getTime() - at.getTime());
      return distance <= LOGIN_RECORD_MATCH_MS && (!ip || !record.ip || record.ip === ip);
    })
    .sort(
      (a, b) =>
        Math.abs(new Date(a.loginTime).getTime() - at.getTime()) -
        Math.abs(new Date(b.loginTime).getTime() - at.getTime())
    )[0];

const nonEmpty = (value: string | undefined | null): string | undefined => value?.trim() || undefined;
// The client login recorder writes the literal 'Unknown' when it cannot parse a field.
const known = (value: string | undefined | null): string | undefined => {
  const trimmed = nonEmpty(value);
  return trimmed?.toLowerCase() === 'unknown' ? undefined : trimmed;
};

export const authRowToSignIn = (row: UserAuthAuditRow, loginRecords: readonly ILoginRecord[]): UserSignIn => {
  const record = row.event === 'login_success' ? matchLoginRecord(row.createdAt, row.actorIp, loginRecords) : undefined;
  const parsed = describeUserAgent(row.userAgent);
  return {
    id: row._id.toString(),
    at: row.createdAt,
    result: SIGN_IN_EVENT_RESULTS[row.event] ?? 'success',
    event: row.event,
    method: nonEmpty(row.strategy),
    ip: nonEmpty(row.actorIp),
    userAgent: nonEmpty(row.userAgent),
    location: known(record?.location),
    browser: known(record?.browser) ?? parsed.browser,
    operatingSystem: known(record?.operatingSystem) ?? parsed.operatingSystem,
    deviceType: known(record?.deviceType),
  };
};

/** One page of sign-in attempts from the auth audit (kept 12 months), newest first. */
export const listUserSignIns = async (
  userId: string,
  loginRecords: readonly ILoginRecord[],
  page: { limit: number; cursor?: AuditLogCursor }
): Promise<{ entries: UserSignIn[]; nextCursor: AuditLogCursor | null }> => {
  const rows = await UserAuthAuditLogModel.find({
    $and: [{ userId, event: { $in: SIGN_IN_EVENTS } }, ...createdAtCursorClauses(page.cursor)],
  })
    .sort({ createdAt: -1, _id: -1 })
    .limit(page.limit + 1)
    .maxTimeMS(QUERY_MAX_TIME_MS)
    .lean<UserAuthAuditRow[]>();
  const entries = rows.slice(0, page.limit).map(row => authRowToSignIn(row, loginRecords));
  const last = entries[entries.length - 1];
  return { entries, nextCursor: rows.length > page.limit && last ? { occurredAt: last.at, id: last.id } : null };
};

type ClusterUserRow = { _id: Types.ObjectId; name?: string; email?: string; createdAt: Date };

/**
 * Accounts that signed up with the same TLS fingerprint (JA4) within the window either side of this
 * signup; served by the `user_signup_fingerprint_window` index. The same signal groups signups in
 * findSignupFingerprintClusters.
 */
export const findSignupCluster = async (user: {
  id: string;
  createdAt: Date;
  signupMeta?: { ja4?: string | null } | null;
}): Promise<UserSignupCluster> => {
  const ja4 = user.signupMeta?.ja4;
  const windowDays = SIGNUP_CLUSTER_WINDOW_DAYS;
  if (!ja4) return { fingerprintAvailable: false, windowDays, matches: [], truncated: false };

  const created = new Date(user.createdAt).getTime();
  const rows = await User.find({
    createdAt: { $gte: new Date(created - windowDays * DAY_MS), $lte: new Date(created + windowDays * DAY_MS) },
    'signupMeta.ja4': ja4,
    _id: { $ne: user.id },
  })
    .select('_id name email createdAt')
    .sort({ createdAt: 1 })
    .limit(MAX_SIGNUP_CLUSTER_MATCHES + 1)
    .maxTimeMS(QUERY_MAX_TIME_MS)
    .lean<ClusterUserRow[]>();

  return {
    fingerprintAvailable: true,
    windowDays,
    matches: rows.slice(0, MAX_SIGNUP_CLUSTER_MATCHES).map(row => ({
      id: row._id.toString(),
      name: row.name?.trim() || row.email || row._id.toString(),
      email: row.email,
      createdAt: row.createdAt,
    })),
    truncated: rows.length > MAX_SIGNUP_CLUSTER_MATCHES,
  };
};
