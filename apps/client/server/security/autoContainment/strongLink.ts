import type { RecordShadowDetectionInput, UserSignupLinkFacts } from '@bike4mind/database';
import { cacheRepository, shadowDetectionRepository, userRepository } from '@bike4mind/database';
import type { Logger } from '@bike4mind/observability';
import { findLinkedAccounts, type LinkedAccount } from '@server/billing/linkedAccounts';
import { assessShadowDetection } from '@server/security/abuseAssessment/abuseAssessment';
import { linkedAccountGroupEvidence } from '@server/security/abuseAssessment/linkedAccountEvidence';
import { applyAutoContainment, liveAutoContainmentDeps, loadAutoContainmentConfig } from './executor';

/**
 * The strong-link rule: a new account whose signup IP matches an account that is blocked (suspended,
 * contained, dispute-locked or moderated) and that signed up within autoContainmentConfig
 * .strongLinkWindowHours of it is recorded as a `signupIpLinkedToBlocked` detection and assessed at
 * once, instead of waiting for the hourly sweep; the judgment then goes straight to automated
 * containment. Run after the account's signup risk-evidence refresh (queueHandlers/riskEvidence.ts),
 * so the assessment sees fresh evidence.
 */

const HOUR_MS = 60 * 60 * 1000;
export const SIGNUP_IP_LINKED_TO_BLOCKED_POLICY_VERSION = 1;
const DEDUPE_KEY_PREFIX = 'shadow-detection:signup-ip-linked-to-blocked';
// One detection per account for as long as a signup can still be "new" under the largest window.
const DEDUPE_TTL_MS = 31 * 24 * HOUR_MS;

export type StrongLinkResult =
  | { status: 'skipped'; reason: 'disabled' | 'no_signup_ip' | 'no_strong_link' | 'already_recorded' }
  | { status: 'recorded'; detectionId: string; assessed: boolean; contained: boolean };

export type StrongLinkDeps = {
  loadWindowHours: () => Promise<number | null>;
  findSignupLinkFacts: (ids: string[]) => Promise<UserSignupLinkFacts[]>;
  findLinkedAccounts: (user: { id: string; signupMeta: { ip: string } }) => Promise<LinkedAccount[]>;
  claimOnce: (userId: string) => Promise<boolean>;
  /** Undoes claimOnce when the detection was not written, so a retry records it. */
  releaseClaim: (userId: string) => Promise<unknown>;
  recordDetection: (input: RecordShadowDetectionInput) => Promise<string>;
  /** Assesses the detection and hands the judgment to automated containment; true when contained or would be. */
  assessAndContain: (detectionId: string) => Promise<{ assessed: boolean; contained: boolean }>;
  now: () => Date;
};

/** The blocked accounts on the same signup IP that signed up within `windowHours` of the account. */
export function strongLinks(
  account: UserSignupLinkFacts,
  linked: LinkedAccount[],
  windowHours: number
): LinkedAccount[] {
  if (!account.createdAt) return [];
  const createdAt = account.createdAt.getTime();
  return linked.filter(
    link =>
      link.blocked &&
      link.via.includes('signupNetwork') &&
      link.createdAt !== null &&
      Math.abs(createdAt - link.createdAt.getTime()) <= windowHours * HOUR_MS
  );
}

export function buildStrongLinkDetection(
  account: UserSignupLinkFacts,
  links: LinkedAccount[],
  windowHours: number,
  detectedAt: Date
): RecordShadowDetectionInput {
  const createdAt = account.createdAt?.getTime() ?? detectedAt.getTime();
  const closestHours = Math.min(
    ...links.map(link => Math.round(Math.abs(createdAt - (link.createdAt?.getTime() ?? createdAt)) / HOUR_MS))
  );
  return {
    detector: 'signupIpLinkedToBlocked',
    policyVersion: SIGNUP_IP_LINKED_TO_BLOCKED_POLICY_VERSION,
    wouldAction: 'contain',
    summary:
      `Signed up from the same IP as ${links.length} blocked account${links.length === 1 ? '' : 's'}, ` +
      `the closest ${closestHours} hour${closestHours === 1 ? '' : 's'} apart`,
    userIds: [account.id],
    // No IP on the record: the link is the evidence, and the admin page links the accounts.
    network: null,
    signals: [
      {
        key: 'blockedSignupIpLinks',
        label: 'Blocked accounts on the same signup IP',
        observed: links.length,
        threshold: 1,
      },
      {
        key: 'hoursToBlockedLink',
        label: 'Hours between this signup and the closest blocked one',
        observed: closestHours,
        threshold: windowHours,
      },
    ],
    windowMinutes: windowHours * 60,
    group: null,
    payment: null,
    detectedAt,
  };
}

export function liveStrongLinkDeps(logger: Logger): StrongLinkDeps {
  return {
    loadWindowHours: async () => {
      const config = await loadAutoContainmentConfig();
      return config.mode === 'off' || config.strongLinkWindowHours === 0 ? null : config.strongLinkWindowHours;
    },
    findSignupLinkFacts: ids => userRepository.findSignupLinkFacts(ids),
    findLinkedAccounts: user => findLinkedAccounts(user),
    claimOnce: async userId =>
      (await cacheRepository.claimDedup(`${DEDUPE_KEY_PREFIX}:${userId}`, { userId }, DEDUPE_TTL_MS)).claimed,
    releaseClaim: userId => cacheRepository.deleteByKey(`${DEDUPE_KEY_PREFIX}:${userId}`),
    recordDetection: input => shadowDetectionRepository.record(input),
    assessAndContain: async detectionId => {
      const outcome = await assessShadowDetection({
        detectionId,
        trigger: 'strong_link',
        requestedBy: null,
        logger,
        deps: { groupEvidence: linkedAccountGroupEvidence },
      });
      if (outcome.status !== 'assessed') return { assessed: false, contained: false };
      const run = await applyAutoContainment(outcome.item, liveAutoContainmentDeps(logger));
      const contained =
        run.status === 'decided' && (run.decision.outcome === 'contained' || run.decision.outcome === 'would_contain');
      return { assessed: true, contained };
    },
    now: () => new Date(),
  };
}

/** Applies the strong-link rule to one account. Throws only on a database failure. */
export async function checkStrongLink(userId: string, deps: StrongLinkDeps): Promise<StrongLinkResult> {
  const windowHours = await deps.loadWindowHours();
  if (windowHours === null) return { status: 'skipped', reason: 'disabled' };
  const [account] = await deps.findSignupLinkFacts([userId]);
  if (!account?.signupIp) return { status: 'skipped', reason: 'no_signup_ip' };

  const links = strongLinks(
    account,
    await deps.findLinkedAccounts({ id: account.id, signupMeta: { ip: account.signupIp } }),
    windowHours
  );
  if (links.length === 0) return { status: 'skipped', reason: 'no_strong_link' };
  if (!(await deps.claimOnce(account.id))) return { status: 'skipped', reason: 'already_recorded' };

  let detectionId: string;
  try {
    detectionId = await deps.recordDetection(buildStrongLinkDetection(account, links, windowHours, deps.now()));
  } catch (error) {
    await deps.releaseClaim(account.id);
    throw error;
  }
  const { assessed, contained } = await deps.assessAndContain(detectionId);
  return { status: 'recorded', detectionId, assessed, contained };
}
