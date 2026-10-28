import { z } from 'zod';
import type { AuditEntry } from './AdminAuditLogTypes';
import type { IActiveSessionDto } from './AuthSessionTypes';

/**
 * The sources merged into a user's Activity timeline. Each is one store, paged on the same
 * (at, id) keyset by the server; see apps/client/server/utils/userTimeline.ts.
 */
export const USER_TIMELINE_TYPES = ['signin', 'usage', 'credit', 'key', 'admin'] as const;
export const UserTimelineTypeSchema = z.enum(USER_TIMELINE_TYPES);
export type UserTimelineType = z.infer<typeof UserTimelineTypeSchema>;

type UserTimelineEntryBase = {
  id: string;
  at: Date;
  /** One plain-language line, e.g. "Signed in with Google". */
  summary: string;
  /** Muted second line, e.g. "203.0.113.7, Chrome on macOS". */
  detail?: string;
};

/** Audit-backed entries carry the full row so the UI can open it in the audit drawer. */
export type UserTimelineAuditEntry = UserTimelineEntryBase & {
  type: 'signin' | 'key' | 'admin';
  audit: AuditEntry;
};

export type UserTimelineUsageEntry = UserTimelineEntryBase & { type: 'usage'; notebookId: string };

export type UserTimelineCreditEntry = UserTimelineEntryBase & {
  type: 'credit';
  /** Signed delta. */
  credits: number;
  transactionType: string;
};

export type UserTimelineEntry = UserTimelineAuditEntry | UserTimelineUsageEntry | UserTimelineCreditEntry;

export type UserTimelinePage = { entries: UserTimelineEntry[]; nextCursor: string | null };

/** `failed` and `blocked` cover only what the auth audit records today; see SIGN_IN_EVENT_RESULTS on the server. */
export const USER_SIGN_IN_RESULTS = ['success', 'failed', 'blocked'] as const;
export type UserSignInResult = (typeof USER_SIGN_IN_RESULTS)[number];

export type UserSignIn = {
  id: string;
  at: Date;
  result: UserSignInResult;
  /** The auth audit event, e.g. `login_success` or `step_up_failed`. */
  event: string;
  /** Auth strategy as stored (`otc`, `google`, `saml`, ...); absent on older rows. */
  method?: string;
  ip?: string;
  userAgent?: string;
  /** From the matching client login record, when one was captured within a few minutes. */
  location?: string;
  browser?: string;
  operatingSystem?: string;
  deviceType?: string;
};

export type UserSignInsPage = { entries: UserSignIn[]; nextCursor: string | null };

export const SIGNUP_CLUSTER_WINDOW_DAYS = 7;

/** Other accounts that signed up with the same TLS fingerprint (JA4) within the window either side. */
export type UserSignupCluster = {
  /** False when this signup has no stored fingerprint, so no cluster can be computed. */
  fingerprintAvailable: boolean;
  windowDays: number;
  matches: Array<{ id: string; name: string; email?: string; createdAt: Date }>;
  /** True when more accounts matched than were returned. */
  truncated: boolean;
};

/** Sign-in and signup methods as admins read them. Stored values are free strings (auth strategy names). */
export const AUTH_METHODS = ['otc', 'password', 'google', 'github', 'okta', 'saml', 'other'] as const;
export const AuthMethodSchema = z.enum(AUTH_METHODS);
export type AuthMethod = z.infer<typeof AuthMethodSchema>;

export const AUTH_METHOD_LABELS: Readonly<Record<AuthMethod, string>> = {
  otc: 'One-time code',
  password: 'Password',
  google: 'Google',
  github: 'GitHub',
  okta: 'Okta',
  saml: 'SSO (SAML)',
  other: 'Other',
};

// `local` is the passport strategy name for email and password.
const AUTH_METHOD_ALIASES: Readonly<Record<string, AuthMethod>> = { local: 'password' };

/** Null for a missing value; an unknown one maps to `other` rather than failing. */
export const normalizeAuthMethod = (raw: string | null | undefined): AuthMethod | null => {
  const value = raw?.trim().toLowerCase();
  if (!value) return null;
  const parsed = AuthMethodSchema.safeParse(AUTH_METHOD_ALIASES[value] ?? value);
  return parsed.success ? parsed.data : 'other';
};

/** The label for a stored method; an unknown legacy value is shown as stored, so nothing reads as blank. */
export const authMethodLabel = (raw: string | null | undefined): string | undefined => {
  const method = normalizeAuthMethod(raw);
  if (method === null) return undefined;
  return method === 'other' ? `Other (${raw?.trim()})` : AUTH_METHOD_LABELS[method];
};

/** A user's active session as an admin sees it; `current` flags the admin's own session, which cannot be revoked here. */
export type AdminUserSession = IActiveSessionDto;
