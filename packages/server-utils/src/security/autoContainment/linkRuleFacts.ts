import { StandardUnit } from '@aws-sdk/client-cloudwatch';
import { emailDomainCandidates, type AutoContainmentConfig, type LinkRuleFacts } from '@bike4mind/common';
import {
  loadDeviceLinkAccounts,
  signupDomainReviewRepository,
  signupProtectionRepository,
  usageEventRepository,
  userRepository,
} from '@bike4mind/database';
import type { IUserSpendProfile, UserAccountRiskProfile, UserSignupLinkCandidate } from '@bike4mind/database';
import type { Logger } from '@bike4mind/observability';
import { Resource } from 'sst';
import { getActiveSubscriptionsForUser } from '../../entitlements/activeSubscriptions';
import { hasPaidSubscription, hasPurchasedCredits } from '../../entitlements/paidStanding';
import { accountLinkKeys } from '../accountLinkSignals';
import { LINK_CANDIDATE_LIMIT } from '../abuseAssessment/accountProfile';
import { emitMetric } from '../../utils/cloudwatch';
import { DEFAULT_DEVICE_LINK_CONFIG, evaluateDeviceLinks, liveDeviceLinkReaders } from './deviceLinkEvaluation';

/**
 * The facts the automated-containment link rules read per account
 * (apps/workers/src/security/autoContainment/linkRules.ts). Bounded: at most maxAccountsPerDetection
 * accounts and LINK_CANDIDATE_LIMIT domain candidates each. Fails closed per fact: a failed read
 * leaves the fact unable to fire its rule (paying and partner read as true, the rest as unknown),
 * is logged, and never throws.
 */

const HOUR_MS = 60 * 60 * 1000;
/**
 * Same fallback as the assessment's account profile (abuseAssessment/accountProfile.ts) when the
 * strong-link rule is off (0).
 */
const DEFAULT_LINK_WINDOW_HOURS = 72;

export type BannedDeviceLinks = Map<string, { blockedUserId: string }[]>;

export type LinkRuleFactsDeps = {
  findAccountRiskProfiles: (ids: string[]) => Promise<UserAccountRiskProfile[]>;
  findCreditPurchaseStamps: (ids: string[]) => Promise<Map<string, Date | null>>;
  findActiveSubscriptions: (userId: string) => Promise<readonly { priceId: string }[]>;
  isOrganizationDomain: (email: string) => Promise<boolean>;
  findAdminBlockedDomain: (candidates: string[]) => Promise<string | null>;
  findSignupLinkCandidates: typeof userRepository.findSignupLinkCandidates;
  /** Spend from usage events since `since`; ids with no spend are absent. */
  spendProfileByUsers: (ids: string[], since: Date) => Promise<Record<string, IUserSpendProfile>>;
  /** Per account, the banned accounts it shares an uncommon, corroborated device with. */
  bannedDeviceLinks: (ids: string[], config: AutoContainmentConfig) => Promise<BannedDeviceLinks>;
  /** Counts a failed fact read, so a persistent failure that quietly turns its rule off is visible. Never throws. */
  recordFactFailure: (fact: string) => Promise<void>;
};

export const liveLinkRuleFactsDeps: LinkRuleFactsDeps = {
  findAccountRiskProfiles: ids => userRepository.findAccountRiskProfiles(ids),
  findCreditPurchaseStamps: ids => userRepository.findCreditPurchaseStamps(ids),
  findActiveSubscriptions: userId => getActiveSubscriptionsForUser(userId, { strict: true }),
  isOrganizationDomain: email => signupProtectionRepository.isOrganizationDomain(email),
  findAdminBlockedDomain: candidates => signupDomainReviewRepository.findAdminBlockedDomain(candidates),
  findSignupLinkCandidates: input => userRepository.findSignupLinkCandidates(input),
  spendProfileByUsers: (ids, since) => usageEventRepository.spendProfileByUsers(ids, since, 1),
  // Same policy as the assessment's device evidence (abuseAssessment/linkedAccountEvidence.ts).
  bannedDeviceLinks: async (ids, config) => {
    const results = await evaluateDeviceLinks(
      await loadDeviceLinkAccounts(ids),
      {
        windowHours: config.deviceLinkWindowHours || DEFAULT_DEVICE_LINK_CONFIG.windowHours,
        commonNetworks: config.deviceLinkCommonNetworks,
      },
      liveDeviceLinkReaders
    );
    return new Map([...results].map(([id, result]) => [id, result.linked ? result.matches : []]));
  },
  recordFactFailure: fact =>
    emitMetric(
      'Lumina5/AutoContainment',
      'LinkRuleFactFailures',
      1,
      { Stage: Resource.App.stage, Fact: fact },
      StandardUnit.Count
    ),
};

const DAY_MS = 24 * 60 * 60 * 1000;
// Bounds the usage-event scan, which times out when stretched over a long-lived account.
const SPEND_LOOKBACK_DAYS = 30;

type DomainCluster = { domain: string; members: UserSignupLinkCandidate[] };

export async function loadLinkRuleFacts(
  userIds: readonly string[],
  config: AutoContainmentConfig,
  deps: LinkRuleFactsDeps = liveLinkRuleFactsDeps,
  logger?: Pick<Logger, 'warn'>,
  now: Date = new Date()
): Promise<LinkRuleFacts[]> {
  const ids = [...new Set(userIds)].slice(0, config.maxAccountsPerDetection);
  if (ids.length === 0) return [];
  const read = async <T>(fact: string, run: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      logger?.warn('[AUTO_CONTAINMENT] link-rule fact unavailable; its rule cannot fire', {
        fact,
        errorName: error instanceof Error ? error.name : typeof error,
      });
      await deps.recordFactFailure(fact);
      return fallback;
    }
  };

  const accounts = await read('accounts', () => deps.findAccountRiskProfiles(ids), null);
  if (!accounts) return [];
  const members = new Set(ids);
  const windowHours = config.strongLinkWindowHours || DEFAULT_LINK_WINDOW_HOURS;

  const [deviceLinks, clusters] = await Promise.all([
    read('bannedSameDevice', () => deps.bannedDeviceLinks(ids, config), null),
    Promise.all(accounts.map(account => domainClusterOf(account, windowHours, deps, read))),
  ]);

  // Spend is read since the later of the earliest signup and the lookback: no account spends before it
  // exists, and one old account must not stretch the scan for every id.
  const spendIds = [...new Set([...ids, ...clusters.flatMap(cluster => cluster?.members.map(m => m.id) ?? [])])];
  const signups = [
    ...accounts.map(account => account.createdAt),
    ...clusters.flatMap(cluster => cluster?.members.map(m => m.createdAt) ?? []),
  ].filter((date): date is Date => date !== null);
  const earliest = signups.length > 0 ? Math.min(...signups.map(date => date.getTime())) : null;
  const since = earliest === null ? null : new Date(Math.max(earliest, now.getTime() - SPEND_LOOKBACK_DAYS * DAY_MS));
  const [stamps, spend] = await Promise.all([
    read('paying', () => deps.findCreditPurchaseStamps(spendIds), null),
    since ? read('creditsSpent', () => deps.spendProfileByUsers(spendIds, since), null) : null,
  ]);
  const spentOf = (id: string) => spend?.[id]?.totalCredits ?? 0;
  // Cluster members overlap across the detection's accounts, so each standing is read once.
  const standings = new Map<string, Promise<boolean>>();
  const isPaying = (id: string): Promise<boolean> => {
    const known = standings.get(id) ?? payingOf(id, stamps, deps, read);
    standings.set(id, known);
    return known;
  };

  return Promise.all(
    accounts.map(async (account, index): Promise<LinkRuleFacts> => {
      const email = account.email;
      const cluster = clusters[index];
      const blockedDevices = deviceLinks?.get(account.id) ?? [];
      return {
        userId: account.id,
        paying: await isPaying(account.id),
        // An account with no email cannot be checked against partner domains and reads false, so only
        // the device rule can still fire for it.
        partnerDomain: email ? await read('partnerDomain', () => deps.isOrganizationDomain(email), true) : false,
        // No spend read leaves every account at zero, which no spend-gated rule fires on.
        creditsSpent: account.createdAt ? spentOf(account.id) : 0,
        ownedDomainCluster: cluster && spend ? await clusterFacts(account.id, cluster, spentOf, isPaying) : null,
        adminHeldDomain: email
          ? await read('heldSignupDomain', () => deps.findAdminBlockedDomain(emailDomainCandidates(email)), null)
          : null,
        bannedSameDevice: deviceLinks
          ? new Set(blockedDevices.map(match => match.blockedUserId).filter(id => !members.has(id))).size
          : null,
      };
    })
  );
}

/**
 * The cluster's counts, or null when another member is paying: a paying colleague marks the domain a real
 * organization, so the rule must not fire for anyone on it. Only spenders are checked: they are the
 * members the rule counts, and that bounds the subscription reads.
 */
async function clusterFacts(
  userId: string,
  cluster: DomainCluster,
  spentOf: (id: string) => number,
  isPaying: (id: string) => Promise<boolean>
): Promise<NonNullable<LinkRuleFacts['ownedDomainCluster']> | null> {
  const memberSpenders = cluster.members.filter(member => spentOf(member.id) > 0);
  const paying = await Promise.all(memberSpenders.map(member => isPaying(member.id)));
  if (paying.some(Boolean)) return null;
  return {
    domain: cluster.domain,
    accounts: 1 + cluster.members.length,
    spenders: memberSpenders.length + (spentOf(userId) > 0 ? 1 : 0),
  };
}

async function payingOf(
  userId: string,
  stamps: Map<string, Date | null> | null,
  deps: LinkRuleFactsDeps,
  read: <T>(fact: string, run: () => Promise<T>, fallback: T) => Promise<T>
): Promise<boolean> {
  if (!stamps) return true;
  if (hasPurchasedCredits({ lastCreditsPurchasedAt: stamps.get(userId) ?? null })) return true;
  const subscriptions = await read('paying', () => deps.findActiveSubscriptions(userId), null);
  return subscriptions === null || hasPaidSubscription(subscriptions);
}

/**
 * Accounts on the same owned mail domain that signed up within the window of this one; null when it
 * has none to share.
 */
async function domainClusterOf(
  account: UserAccountRiskProfile,
  windowHours: number,
  deps: LinkRuleFactsDeps,
  read: <T>(fact: string, run: () => Promise<T>, fallback: T) => Promise<T>
): Promise<DomainCluster | null> {
  const domain = accountLinkKeys(account).mailDomain;
  if (!domain || !account.createdAt) return null;
  const signedUp = account.createdAt.getTime();
  const candidates = await read(
    'sharedOwnedDomain',
    () =>
      deps.findSignupLinkCandidates({
        excludeIds: [account.id],
        from: new Date(signedUp - windowHours * HOUR_MS),
        to: new Date(signedUp + windowHours * HOUR_MS),
        ip: null,
        ja4: null,
        mailbox: null,
        mailDomain: domain,
        limit: LINK_CANDIDATE_LIMIT,
      }),
    null
  );
  if (!candidates) return null;
  const members = candidates.filter(
    candidate => candidate.id !== account.id && candidate.createdAt && accountLinkKeys(candidate).mailDomain === domain
  );
  return { domain, members };
}
