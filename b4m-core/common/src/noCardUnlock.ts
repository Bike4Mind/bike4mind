export const NO_CARD_UNLOCK_REASONS = ['github_verified', 'work_email_verified'] as const;
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
}

function parsePositiveInt(raw: unknown): number {
  const n = typeof raw === 'string' ? (raw.trim() === '' ? NaN : Number(raw)) : raw;
  return typeof n === 'number' && Number.isSafeInteger(n) && n > 0 ? n : 0;
}

function parseFlag(raw: unknown): boolean {
  return raw === true || (typeof raw === 'string' && raw.trim().toLowerCase() === 'true');
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
  };
}
