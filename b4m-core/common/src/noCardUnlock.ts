export const NO_CARD_UNLOCK_REASONS = ['github_verified', 'work_email_verified', 'phone_verified'] as const;
export type NoCardUnlockReason = (typeof NO_CARD_UNLOCK_REASONS)[number];

export type NoCardUnlockRefusal =
  | 'disabled'
  | 'github_not_linked'
  | 'github_reauthorize_required'
  | 'github_rate_limited'
  | 'github_too_new'
  | 'github_few_repos'
  | 'github_email_unverified'
  | 'github_already_claimed'
  | 'work_email_free'
  | 'work_email_disposable'
  | 'work_email_no_mx'
  | 'work_email_catch_all'
  | 'work_email_probe_inconclusive'
  | 'domain_cap_reached'
  | 'phone_invalid'
  | 'phone_line_type'
  | 'phone_blocked'
  | 'phone_already_claimed'
  | 'phone_rate_limited'
  | 'phone_unavailable'
  | 'phone_not_started'
  | 'phone_code_invalid'
  | 'signup_held'
  | 'signup_grant_pending'
  | 'daily_budget_reached'
  | 'cap_reached'
  | 'already_granted';

export function noCardUnlockTransactionId(reason: NoCardUnlockReason, userId: string): string {
  return `unlock-grant:${reason}:${userId}`;
}

export interface NoCardUnlockSettings {
  enabled: boolean;
  githubCredits: number;
  workEmailCredits: number;
  maxCredits: number;
  githubMinAgeDays: number;
  githubMinRepos: number;
  workEmailDomainDailyCap: number;
  probeInconclusiveAllows: boolean;
  phoneEnabled: boolean;
  phoneCredits: number;
  phoneBlockedPrefixes: string[];
  phoneAsnDailyCap: number;
  phoneCountryDailyCap: number;
}

/** Defaults for the network-wide phone caps, so an unset setting never blocks every send. */
export const PHONE_UNLOCK_DEFAULT_ASN_DAILY_CAP = 50;
export const PHONE_UNLOCK_DEFAULT_COUNTRY_DAILY_CAP = 200;

function parsePositiveInt(raw: unknown): number {
  const n = typeof raw === 'string' ? (raw.trim() === '' ? NaN : Number(raw)) : raw;
  return typeof n === 'number' && Number.isSafeInteger(n) && n > 0 ? n : 0;
}

function parseFlag(raw: unknown): boolean {
  return raw === true || (typeof raw === 'string' && raw.trim().toLowerCase() === 'true');
}

/** Shared by the verify route and the billing form so a code the form accepts is never a 400. */
export const PHONE_UNLOCK_CODE_PATTERN = /^\d{4,10}$/;
/** Longest raw phone input the start route accepts, formatting characters included. */
export const PHONE_UNLOCK_INPUT_MAX_LENGTH = 32;

const E164 = /^\+[1-9]\d{6,14}$/;
const PHONE_PREFIX = /^\+[1-9]\d{0,14}$/;

/** Strips spaces, dashes, dots and parentheses; returns null unless the rest is a full E.164 number. */
export function normalizeE164(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const compact = raw.replace(/[\s\-.()]/g, '');
  return E164.test(compact) ? compact : null;
}

/** Object settings arrive as a JSON string or an array; malformed entries are dropped, not fatal. */
function parsePhonePrefixes(raw: unknown): string[] {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  return value
    .map(entry => (typeof entry === 'string' ? entry.replace(/[\s\-.()]/g, '') : ''))
    .filter(entry => PHONE_PREFIX.test(entry));
}

export function isBlockedPhone(e164: string, blockedPrefixes: readonly string[]): boolean {
  return blockedPrefixes.some(prefix => e164.startsWith(prefix));
}

/** Unset or malformed values resolve to disabled/0. A 0 age or repo minimum is unconfigured, which the GitHub validator refuses. */
export function resolveNoCardUnlockSettings(adminSettings: Record<string, unknown>): NoCardUnlockSettings {
  return {
    enabled: parseFlag(adminSettings.noCardUnlockEnabled),
    githubCredits: parsePositiveInt(adminSettings.noCardUnlockGithubCredits),
    workEmailCredits: parsePositiveInt(adminSettings.noCardUnlockWorkEmailCredits),
    maxCredits: parsePositiveInt(adminSettings.noCardUnlockMaxCredits),
    githubMinAgeDays: parsePositiveInt(adminSettings.noCardUnlockGithubMinAgeDays),
    githubMinRepos: parsePositiveInt(adminSettings.noCardUnlockGithubMinRepos),
    workEmailDomainDailyCap: parsePositiveInt(adminSettings.noCardUnlockWorkEmailDomainDailyCap),
    probeInconclusiveAllows: parseFlag(adminSettings.noCardUnlockProbeInconclusiveAllows),
    phoneEnabled: parseFlag(adminSettings.noCardUnlockPhoneEnabled),
    phoneCredits: parsePositiveInt(adminSettings.noCardUnlockPhoneCredits),
    phoneBlockedPrefixes: parsePhonePrefixes(adminSettings.noCardUnlockPhoneBlockedPrefixes),
    phoneAsnDailyCap:
      parsePositiveInt(adminSettings.noCardUnlockPhoneAsnDailyCap) || PHONE_UNLOCK_DEFAULT_ASN_DAILY_CAP,
    phoneCountryDailyCap:
      parsePositiveInt(adminSettings.noCardUnlockPhoneCountryDailyCap) || PHONE_UNLOCK_DEFAULT_COUNTRY_DAILY_CAP,
  };
}
