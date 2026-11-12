import type { Logger } from '@bike4mind/observability';
import { cacheRepository, shadowDetectionRepository, userRepository } from '@bike4mind/database';
import type {
  RecordShadowDetectionInput,
  UserAccountRiskProfile,
  YoungAccountSpendSummary,
  YoungAccountSpender,
} from '@bike4mind/database';
import { groupLinkedAccounts, type AccountLinkKind } from '@bike4mind/server-utils/security/accountLinkSignals';
import type { YoungAccountSpendThresholds } from './youngAccountSpendAlert';

/**
 * Shadow detections for the young-account spend alert (contract in shadowDetection.ts in
 * @bike4mind/common): what policy v1 would have done to each account the alert lists, recorded for
 * admin grading on the Detections page. Recording only writes the record; it never touches the
 * account, its credits or keys.
 *
 * The listed spenders are often unrelated people who happened to spend in the same hour, so each
 * detection says which of the others it is linked to (shared signup IP, JA4, mailbox or company mail
 * domain, see accountLinkSignals.ts), and carries the young-account totals as signals only when it is
 * linked to at least one of them.
 */

const HOUR_MS = 60 * 60 * 1000;

/**
 * A breached window would contain every top spender the alert lists. v2 records whether the listed
 * spenders are linked and drops the window totals from unlinked ones. Bump when the mapping
 * changes, so precision is measured per policy.
 */
export const YOUNG_ACCOUNT_SPEND_POLICY_VERSION = 2;

const LINK_KIND_LABELS: Record<AccountLinkKind, string> = {
  signupIp: 'signup IP',
  ja4: 'JA4',
  mailbox: 'mailbox',
  mailDomain: 'mail domain',
};

/** The listed spenders linked to one spender; null when the link facts could not be read. */
export type SpenderCohort = {
  /** The other listed spenders it is linked to, directly or through another listed spender. */
  linkedUserIds: string[];
  kinds: AccountLinkKind[];
  /** Credits the spender and its linked spenders spent in the window. */
  linkedCredits: number;
} | null;

/** Each listed spender's cohort among the listed spenders, from their signup link facts. */
export function spenderCohorts(
  spenders: readonly YoungAccountSpender[],
  facts: readonly Pick<UserAccountRiskProfile, 'id' | 'email' | 'signupIp' | 'signupJa4'>[]
): Map<string, NonNullable<SpenderCohort>> {
  const factsById = new Map(facts.map(fact => [fact.id, fact]));
  const groups = groupLinkedAccounts(
    spenders.map(spender => {
      const fact = factsById.get(spender.userId);
      return {
        id: spender.userId,
        email: fact?.email ?? spender.email,
        signupIp: fact?.signupIp ?? null,
        signupJa4: fact?.signupJa4 ?? null,
      };
    })
  );
  const creditsById = new Map(spenders.map(spender => [spender.userId, spender.creditsSpent]));
  const cohorts = new Map<string, NonNullable<SpenderCohort>>();
  for (const group of groups) {
    const linkedCredits = group.memberIds.reduce((sum, id) => sum + (creditsById.get(id) ?? 0), 0);
    for (const id of group.memberIds) {
      cohorts.set(id, {
        linkedUserIds: group.memberIds.filter(other => other !== id),
        kinds: group.kinds,
        linkedCredits,
      });
    }
  }
  return cohorts;
}

const DEDUPE_KEY_PREFIX = 'shadow-detection:young-account-spend';
// Outlasts async retries and a replay from the DLQ, which keeps a message 14 days from enqueue (after
// the retries, hence the extra hour). The key names the window, so a long claim never hides a later one.
const DEDUPE_TTL_MS = (14 * 24 + 1) * HOUR_MS;

type SpendWindow = { start: Date; end: Date };

export function youngAccountSpendDedupeKey(userId: string, window: SpendWindow): string {
  return `${DEDUPE_KEY_PREFIX}:${userId}:${window.end.toISOString()}`;
}

function formatCount(count: number, noun: string): string {
  return `${count.toLocaleString('en-US')} ${noun}${count === 1 ? '' : 's'}`;
}

/** One detection for one listed spender: the account's own spend beside the fleet totals that tripped. */
function cohortClause(cohort: SpenderCohort, rank: number, summary: YoungAccountSpendSummary): string {
  const position = `#${rank} by spend of ${formatCount(summary.accountCount, 'young account')}`;
  if (cohort === null) return `${position}; links to the other listed spenders unknown`;
  if (cohort.linkedUserIds.length === 0) return `${position}; not linked to the other listed spenders`;
  const kinds = cohort.kinds.map(kind => LINK_KIND_LABELS[kind]).join(', ');
  return (
    `${position}; linked to ${formatCount(cohort.linkedUserIds.length, 'other listed spender')} by ${kinds}, ` +
    `${formatCount(cohort.linkedCredits, 'credit')} together`
  );
}

export function buildYoungAccountSpendShadowDetection(input: {
  spender: YoungAccountSpender;
  rank: number;
  summary: YoungAccountSpendSummary;
  thresholds: YoungAccountSpendThresholds;
  window: SpendWindow;
  cohort: SpenderCohort;
}): RecordShadowDetectionInput {
  const { spender, rank, summary, thresholds, window, cohort } = input;
  const windowMinutes = Math.round((window.end.getTime() - window.start.getTime()) / 60_000);
  const accountAgeHours = Math.floor((window.end.getTime() - new Date(spender.accountCreatedAt).getTime()) / HOUR_MS);
  const linked = cohort !== null && cohort.linkedUserIds.length > 0;
  return {
    detector: 'youngAccountSpend',
    policyVersion: YOUNG_ACCOUNT_SPEND_POLICY_VERSION,
    wouldAction: 'contain',
    summary:
      `${formatCount(spender.creditsSpent, 'credit')} in ${windowMinutes} minutes from a ${accountAgeHours}-hour-old ` +
      `account (${cohortClause(cohort, rank, summary)})`,
    userIds: [spender.userId],
    network: null,
    signals: [
      {
        key: 'accountCredits',
        label: 'Credits this account spent in the window',
        observed: spender.creditsSpent,
        threshold: null,
      },
      { key: 'spendRank', label: 'Rank among young-account spenders', observed: rank, threshold: null },
      {
        key: 'accountAgeHours',
        label: 'Account age in hours at the end of the window',
        observed: accountAgeHours,
        threshold: null,
      },
      {
        key: 'hasStripeCustomer',
        label: 'Reached Stripe checkout (1 yes, 0 no)',
        observed: spender.stripeCustomerId ? 1 : 0,
        threshold: null,
      },
      {
        key: 'linkedSpenders',
        label: 'Other listed spenders linked to this account (unknown when the link check failed)',
        observed: cohort === null ? null : cohort.linkedUserIds.length,
        threshold: null,
      },
      // Unrelated accounts that spent in the same hour say nothing about this one, so the window
      // totals are evidence only for a linked cohort.
      ...(linked
        ? [
            {
              key: 'linkedSpenderCredits',
              label: 'Credits this account and its linked spenders spent in the window',
              observed: cohort.linkedCredits,
              threshold: null,
            },
            ...cohort.kinds.map(kind => ({
              key: `linkedBy_${kind}`,
              label: `Linked to another listed spender by ${LINK_KIND_LABELS[kind]} (1 yes)`,
              observed: 1,
              threshold: null,
            })),
            {
              key: 'youngAccountCredits',
              label: 'Credits all young accounts spent in the window',
              observed: summary.totalCredits,
              threshold: thresholds.credits,
            },
            {
              key: 'youngAccountCount',
              label: 'Young accounts that spent in the window',
              observed: summary.accountCount,
              threshold: thresholds.accounts,
            },
          ]
        : []),
    ],
    windowMinutes,
    group: null,
    payment: null,
    // The window end, not the clock, so a retried or redriven run records the same detection.
    detectedAt: window.end,
  };
}

/**
 * Records one detection per listed spender that wins its (account, window) claim, so a retried or
 * redriven run never records twice. A failed write releases its claim, so a retry or replay of the same
 * window records it; once the run succeeds, the error log is the only trace of the miss. Never
 * throws: the Slack alert and its failure handling stay exactly as they were. Returns how many
 * detections were written.
 */
export async function recordYoungAccountSpendShadowDetections(input: {
  summary: YoungAccountSpendSummary;
  thresholds: YoungAccountSpendThresholds;
  window: SpendWindow;
  logger: Pick<Logger, 'error'>;
  /** Overrides the live link facts read; for tests. */
  findLinkFacts?: (ids: string[]) => Promise<Pick<UserAccountRiskProfile, 'id' | 'email' | 'signupIp' | 'signupJa4'>[]>;
}): Promise<number> {
  const { summary, thresholds, window, logger } = input;
  const findLinkFacts = input.findLinkFacts ?? (ids => userRepository.findAccountRiskProfiles(ids));
  let cohorts: Map<string, NonNullable<SpenderCohort>> | null = null;
  try {
    cohorts = spenderCohorts(
      summary.topSpenders,
      await findLinkFacts(summary.topSpenders.map(spender => spender.userId))
    );
  } catch (error) {
    logger.error('young-account spend link facts were not read; recording without links', { error });
  }
  const recorded = await Promise.all(
    summary.topSpenders.map(async (spender, index) => {
      const key = youngAccountSpendDedupeKey(spender.userId, window);
      let claimed = false;
      try {
        ({ claimed } = await cacheRepository.claimDedup(key, { userId: spender.userId }, DEDUPE_TTL_MS));
        if (!claimed) return false;
        await shadowDetectionRepository.record(
          buildYoungAccountSpendShadowDetection({
            spender,
            rank: index + 1,
            summary,
            thresholds,
            window,
            cohort: cohorts?.get(spender.userId) ?? null,
          })
        );
        return true;
      } catch (error) {
        if (claimed) {
          await cacheRepository
            .deleteByKey(key)
            .catch((releaseError: unknown) =>
              logger.error('young-account spend shadow detection claim was not released', { error: releaseError })
            );
        }
        logger.error('young-account spend shadow detection was not recorded', { userId: spender.userId, error });
        return false;
      }
    })
  );
  return recorded.filter(Boolean).length;
}
