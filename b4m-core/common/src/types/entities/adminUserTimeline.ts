import { z } from 'zod';
import type { AuditEntry } from './AdminAuditLogTypes';
import type { IActiveSessionDto } from './AuthSessionTypes';

/**
 * The sources merged into a user's Activity timeline. Each is one store, paged on the same
 * (at, id) keyset by the server; see apps/client/server/utils/userTimeline.ts.
 */
export const USER_TIMELINE_TYPES = [
  'signup',
  'signin',
  'key',
  'usage',
  'spend',
  'limit',
  'credit',
  'payment',
  'admin',
  'moderation',
] as const;
export const UserTimelineTypeSchema = z.enum(USER_TIMELINE_TYPES);
export type UserTimelineType = z.infer<typeof UserTimelineTypeSchema>;

/** The filters an admin picks from; each covers several sources. */
export const USER_TIMELINE_CATEGORIES = ['spend', 'security', 'money', 'admin'] as const;
export type UserTimelineCategory = (typeof USER_TIMELINE_CATEGORIES)[number];

export const USER_TIMELINE_CATEGORY_TYPES: Readonly<Record<UserTimelineCategory, readonly UserTimelineType[]>> = {
  spend: ['spend', 'usage', 'limit'],
  security: ['signup', 'signin', 'key'],
  money: ['credit', 'payment'],
  admin: ['admin', 'moderation'],
};

export const USER_TIMELINE_CATEGORY_LABELS: Readonly<Record<UserTimelineCategory, string>> = {
  spend: 'Spend',
  security: 'Security',
  money: 'Money',
  admin: 'Admin',
};

export const userTimelineCategoryOf = (type: UserTimelineType): UserTimelineCategory =>
  USER_TIMELINE_CATEGORIES.find(category => USER_TIMELINE_CATEGORY_TYPES[category].includes(type)) ?? 'admin';

/** The types behind a set of categories, in USER_TIMELINE_TYPES order. */
export const userTimelineTypesFor = (categories: readonly UserTimelineCategory[]): UserTimelineType[] =>
  USER_TIMELINE_TYPES.filter(type => categories.includes(userTimelineCategoryOf(type)));

type UserTimelineEntryBase = {
  id: string;
  at: Date;
  /** One plain-language line, e.g. "Signed in with Google". */
  summary: string;
  /** Muted second line, e.g. "203.0.113.7, Chrome on macOS". */
  detail?: string;
  /** Short tags an admin should notice, e.g. "New IP" or "Disposable domain". */
  flags?: string[];
  /** Set by the server on rows that read as abnormal (a refusal, a negative balance, a failed charge). */
  alert?: boolean;
};

/** Audit-backed entries carry the full row so the UI can open it in the audit drawer. */
export type UserTimelineAuditEntry = UserTimelineEntryBase & {
  type: 'signin' | 'key' | 'admin';
  audit: AuditEntry;
};

export type UserTimelineUsageEntry = UserTimelineEntryBase & { type: 'usage'; notebookId: string };

/**
 * A roll-up of usage charges: one row per UTC hour, notebook, model, usage type, source and API key.
 * `at`/`id` are the newest charge in the group, so the row pages on the shared keyset.
 */
export type UserTimelineSpendEntry = UserTimelineEntryBase & {
  type: 'spend';
  /** Credits spent, positive. */
  credits: number;
  calls: number;
  transactionType: string;
  model?: string;
  notebookId?: string;
  source?: string;
  apiKeyId?: string;
  /** The oldest charge in the group. */
  firstAt: Date;
  /** Balance right after the newest charge; absent when it could not be derived. */
  balanceAfter?: number;
  /** True when the hour held more charges than one read covers, so the totals are a lower bound. */
  partial: boolean;
};

export type UserTimelineCreditEntry = UserTimelineEntryBase & {
  type: 'credit';
  /** Signed delta. */
  credits: number;
  transactionType: string;
};

export type UserTimelineSignupEntry = UserTimelineEntryBase & { type: 'signup' };

/** Refusals and limit hits, one row per user, kind and hour (see UserLimitEventModel). */
export type UserTimelineLimitEntry = UserTimelineEntryBase & {
  type: 'limit';
  kind: UserLimitEventKind;
  count: number;
  firstAt: Date;
};

export type UserTimelinePaymentEntry = UserTimelineEntryBase & { type: 'payment'; outcome: string };

export type UserTimelineModerationEntry = UserTimelineEntryBase & { type: 'moderation'; reviewStatus?: string };

export type UserTimelineEntry =
  | UserTimelineAuditEntry
  | UserTimelineUsageEntry
  | UserTimelineSpendEntry
  | UserTimelineCreditEntry
  | UserTimelineSignupEntry
  | UserTimelineLimitEntry
  | UserTimelinePaymentEntry
  | UserTimelineModerationEntry;

/**
 * Limits and refusals worth showing an admin. Recorded at the refusal sites through
 * recordUserLimitEvent (apps/client/server/billing/userLimitEvents.ts).
 */
export const USER_LIMIT_EVENT_KINDS = [
  'new_account_hourly_cap',
  'new_account_daily_cap',
  'free_tier_daily_cap',
  'model_requires_paid_plan',
  'insufficient_credits',
  'api_key_spend_cap',
  'balance_debt',
  'debt_written_off',
] as const;
export const UserLimitEventKindSchema = z.enum(USER_LIMIT_EVENT_KINDS);
export type UserLimitEventKind = z.infer<typeof UserLimitEventKindSchema>;

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

/**
 * Accounts linked to a user through payments or signup: the same card (strong), or only the same
 * signup or payment IP (weak). Built by apps/client/server/billing/linkedAccounts.ts.
 */
export type UserLinkedAccount = {
  id: string;
  name: string | null;
  email: string | null;
  strength: 'strong' | 'weak';
  via: Array<'card' | 'paymentNetwork' | 'signupNetwork'>;
  /** Banned, suspended or dispute-locked. */
  blocked: boolean;
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
