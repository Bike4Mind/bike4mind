import {
  ABUSE_ASSESSMENT_MAX_PROFILE_MODELS,
  AuthStrategy,
  AutoContainmentConfigSchema,
  mailboxAliasesOf,
  type AbuseAssessmentAccountProfile,
} from '@bike4mind/common';
import { adminSettingsRepository, usageEventRepository, userRepository } from '@bike4mind/database';
import type {
  IUserSpendProfile,
  UserAccountRiskProfile,
  UserLinkState,
  UserSignupLinkCandidate,
} from '@bike4mind/database';
import type { Logger } from '@bike4mind/observability';
import { userService } from '@bike4mind/services';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import {
  accountLinkKeys,
  emailPatternSignals,
  sharedLinkKinds,
} from '@bike4mind/server-utils/security/accountLinkSignals';

/**
 * The account profile an advisory abuse assessment sends per account (evidence v2, contract in
 * b4m-core/common/src/schemas/abuseAssessment.ts): the signup network and method, the address's
 * shape, how soon two-factor and the first spend followed signup, spend by model, and the accounts
 * created close to it that share its signup IP, JA4, mailbox or (non-consumer) mail domain. The same
 * facts the admin user page shows, reduced to flags, minutes and counts.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
/** Spend and linked accounts are read this far back; young-account abuse lands within days. */
const SPEND_LOOKBACK_MS = 30 * 24 * HOUR_MS;
/** Used when the strong-link window is switched off (0), so linked accounts are still counted. */
const DEFAULT_LINK_WINDOW_HOURS = 72;
export const LINK_CANDIDATE_LIMIT = 50;

const OAUTH_METHODS: ReadonlySet<string> = new Set(Object.values(AuthStrategy));

const minutesBetween = (from: Date | null, to: Date | null): number | null =>
  from && to ? Math.max(0, Math.round((to.getTime() - from.getTime()) / MINUTE_MS)) : null;

const round = (value: number, places: number) => Math.round(value * 10 ** places) / 10 ** places;

function signupMethodOf(method: string): AbuseAssessmentAccountProfile['signupMethod'] {
  if (method === 'otc') return 'otc';
  if (method === 'email' || method === 'password') return 'email';
  return OAUTH_METHODS.has(method) ? 'oauth' : 'other';
}

function spendOf(spend: IUserSpendProfile | null): AbuseAssessmentAccountProfile['spend'] {
  if (!spend || spend.totalCredits <= 0) return null;
  return {
    totalCredits: round(spend.totalCredits, 2),
    byModel: spend.byModel.slice(0, ABUSE_ASSESSMENT_MAX_PROFILE_MODELS).map(entry => ({
      model: entry.model,
      creditShare: round(entry.credits / spend.totalCredits, 2),
      events: entry.events,
      creditsPerEvent: entry.events > 0 ? round(entry.credits / entry.events, 2) : 0,
    })),
  };
}

export type LinkedAccountsInput = {
  candidates: readonly UserSignupLinkCandidate[];
  windowHours: number;
  /** Whether the scan returned as many rows as it asked for, so more may exist. */
  truncated: boolean;
  isBlocked: (account: UserLinkState) => boolean;
};

function linkedAccountsOf(
  account: UserAccountRiskProfile,
  input: LinkedAccountsInput
): AbuseAssessmentAccountProfile['linkedAccounts'] {
  if (!account.createdAt) return null;
  const self = { email: account.email, signupIp: account.signupIp, signupJa4: account.signupJa4 };
  const createdAt = account.createdAt.getTime();
  const counts = { total: 0, blocked: 0, sharedSignupIp: 0, sharedJa4: 0, sharedMailbox: 0, sharedMailDomain: 0 };
  for (const candidate of input.candidates) {
    if (candidate.id === account.id || !candidate.createdAt) continue;
    if (Math.abs(candidate.createdAt.getTime() - createdAt) > input.windowHours * HOUR_MS) continue;
    const kinds = sharedLinkKinds(self, candidate);
    if (kinds.length === 0) continue;
    counts.total += 1;
    if (input.isBlocked(candidate)) counts.blocked += 1;
    if (kinds.includes('signupIp')) counts.sharedSignupIp += 1;
    if (kinds.includes('ja4')) counts.sharedJa4 += 1;
    if (kinds.includes('mailbox')) counts.sharedMailbox += 1;
    if (kinds.includes('mailDomain')) counts.sharedMailDomain += 1;
  }
  return { windowHours: input.windowHours, ...counts, truncated: input.truncated };
}

/** Pure: the profile for one account from what the loader read. */
export function buildAccountProfile(input: {
  account: UserAccountRiskProfile;
  spend: IUserSpendProfile | null;
  links: LinkedAccountsInput | null;
}): AbuseAssessmentAccountProfile {
  const { account, spend, links } = input;
  const hosting =
    account.signupDatacenter === true || account.signupWafAnonIp === true
      ? true
      : account.signupDatacenter === null && account.signupWafAnonIp !== false
        ? null
        : false;
  const email = emailPatternSignals(account.email);
  return {
    signupMethod: signupMethodOf(account.signupMethod),
    signupNetwork: {
      asnKnown: account.signupAsnKnown,
      hosting,
      datacenter: account.signupDatacenter,
      anonymousIp: account.signupWafAnonIp,
      ja4Present: !!account.signupJa4,
    },
    email,
    minutesToTwoFactor: account.totpEnabled ? minutesBetween(account.createdAt, account.mfaSetupAt) : null,
    minutesToFirstSpend: minutesBetween(account.createdAt, spend?.firstSpendAt ?? null),
    spend: spendOf(spend),
    linkedAccounts: links ? linkedAccountsOf(account, links) : null,
  };
}

export type AccountProfileDeps = {
  findAccountRiskProfiles: (ids: string[]) => Promise<UserAccountRiskProfile[]>;
  spendProfileByUsers: (ids: string[], since: Date) => Promise<Record<string, IUserSpendProfile>>;
  findSignupLinkCandidates: typeof userRepository.findSignupLinkCandidates;
  loadLinkWindowHours: () => Promise<number>;
  isBlocked: (account: UserLinkState) => boolean;
  now: () => Date;
};

const liveDeps: AccountProfileDeps = {
  findAccountRiskProfiles: ids => userRepository.findAccountRiskProfiles(ids),
  spendProfileByUsers: (ids, since) => usageEventRepository.spendProfileByUsers(ids, since),
  findSignupLinkCandidates: input => userRepository.findSignupLinkCandidates(input),
  loadLinkWindowHours: async () => {
    const settings = await getSettingsMap(
      { adminSettings: adminSettingsRepository },
      { names: ['autoContainmentConfig'] }
    );
    const config = getSettingsValue('autoContainmentConfig', settings, AutoContainmentConfigSchema.parse({}));
    return config.strongLinkWindowHours > 0 ? config.strongLinkWindowHours : DEFAULT_LINK_WINDOW_HOURS;
  },
  isBlocked: account => userService.accountBlockReasons(account).length > 0,
  now: () => new Date(),
};

async function linksFor(
  account: UserAccountRiskProfile,
  windowHours: number,
  deps: AccountProfileDeps
): Promise<LinkedAccountsInput | null> {
  if (!account.createdAt) return null;
  const keys = accountLinkKeys(account);
  const candidates = await deps.findSignupLinkCandidates({
    excludeIds: [account.id],
    from: new Date(account.createdAt.getTime() - windowHours * HOUR_MS),
    to: new Date(account.createdAt.getTime() + windowHours * HOUR_MS),
    ip: keys.signupIp,
    ja4: keys.ja4,
    mailbox: account.email ? mailboxAliasesOf(account.email) : null,
    mailDomain: keys.mailDomain,
    limit: LINK_CANDIDATE_LIMIT,
  });
  return {
    candidates,
    windowHours,
    truncated: candidates.length >= LINK_CANDIDATE_LIMIT,
    isBlocked: deps.isBlocked,
  };
}

/**
 * Profiles for `ids`, keyed by id; ids that are not users are absent. A failed linked-account read
 * leaves `linkedAccounts` null for that account. A failed account, spend or settings read rejects
 * the whole load, and the caller assesses without profiles.
 */
export async function loadAccountProfiles(
  ids: readonly string[],
  deps: AccountProfileDeps = liveDeps,
  logger?: Logger
): Promise<Map<string, AbuseAssessmentAccountProfile>> {
  if (ids.length === 0) return new Map();
  const [accounts, spend, windowHours] = await Promise.all([
    deps.findAccountRiskProfiles([...ids]),
    deps.spendProfileByUsers([...ids], new Date(deps.now().getTime() - SPEND_LOOKBACK_MS)),
    deps.loadLinkWindowHours(),
  ]);
  const profiles = await Promise.all(
    accounts.map(async account => {
      const links = await linksFor(account, windowHours, deps).catch((error: unknown) => {
        logger?.warn('Abuse assessment linked-account read failed; profile has no linked accounts', {
          errorName: error instanceof Error ? error.name : typeof error,
        });
        return null;
      });
      return [account.id, buildAccountProfile({ account, spend: spend[account.id] ?? null, links })] as const;
    })
  );
  return new Map(profiles);
}
