import type { Logger } from '@bike4mind/observability';
import { cacheRepository, shadowDetectionRepository } from '@bike4mind/database';
import type { RecordShadowDetectionInput, YoungAccountSpendSummary, YoungAccountSpender } from '@bike4mind/database';
import type { YoungAccountSpendThresholds } from './youngAccountSpendAlert';

/**
 * Shadow detections for the young-account spend alert (contract in shadowDetection.ts in
 * @bike4mind/common): what policy v1 would have done to each account the alert lists, recorded for
 * admin grading on the Detections page. Recording only writes the record; it never touches the
 * account, its credits or keys.
 */

const HOUR_MS = 60 * 60 * 1000;

/**
 * v1: a breached window would contain every top spender the alert lists. Bump when that mapping
 * changes, so precision is measured per policy.
 */
export const YOUNG_ACCOUNT_SPEND_POLICY_VERSION = 1;

const DEDUPE_KEY_PREFIX = 'shadow-detection:young-account-spend';
// Outlasts async retries and a DLQ redrive of the same window (SQS keeps a message at most 14 days).
// The key names the window, so a long claim never hides a later one.
const DEDUPE_TTL_MS = 14 * 24 * HOUR_MS;

type SpendWindow = { start: Date; end: Date };

export function youngAccountSpendDedupeKey(userId: string, window: SpendWindow): string {
  return `${DEDUPE_KEY_PREFIX}:${userId}:${window.end.toISOString()}`;
}

function formatCredits(credits: number): string {
  return credits.toLocaleString('en-US');
}

/** One detection for one listed spender: the account's own spend beside the fleet totals that tripped. */
export function buildYoungAccountSpendShadowDetection(input: {
  spender: YoungAccountSpender;
  rank: number;
  summary: YoungAccountSpendSummary;
  thresholds: YoungAccountSpendThresholds;
  window: SpendWindow;
}): RecordShadowDetectionInput {
  const { spender, rank, summary, thresholds, window } = input;
  const windowMinutes = Math.round((window.end.getTime() - window.start.getTime()) / 60_000);
  const accountAgeHours = Math.floor((window.end.getTime() - new Date(spender.accountCreatedAt).getTime()) / HOUR_MS);
  return {
    detector: 'youngAccountSpend',
    policyVersion: YOUNG_ACCOUNT_SPEND_POLICY_VERSION,
    wouldAction: 'contain',
    summary:
      `${formatCredits(spender.creditsSpent)} credits in ${windowMinutes} minutes from a ${accountAgeHours}-hour-old ` +
      `account (#${rank} of ${summary.accountCount} young accounts, ${formatCredits(summary.totalCredits)} credits in total)`,
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
    ],
    windowMinutes,
    group: null,
    // The window end, not the clock, so a retried or redriven run records the same detection.
    detectedAt: window.end,
  };
}

/**
 * Records one detection per listed spender that wins its (account, window) claim, so a retried or
 * redriven run never records twice. A failed write releases its claim for the next run. Never
 * throws: the Slack alert and its failure handling stay exactly as they were. Returns how many
 * detections were written.
 */
export async function recordYoungAccountSpendShadowDetections(input: {
  summary: YoungAccountSpendSummary;
  thresholds: YoungAccountSpendThresholds;
  window: SpendWindow;
  logger: Pick<Logger, 'error'>;
}): Promise<number> {
  const { summary, thresholds, window, logger } = input;
  const recorded = await Promise.all(
    summary.topSpenders.map(async (spender, index) => {
      const key = youngAccountSpendDedupeKey(spender.userId, window);
      let claimed = false;
      try {
        ({ claimed } = await cacheRepository.claimDedup(key, { userId: spender.userId }, DEDUPE_TTL_MS));
        if (!claimed) return false;
        await shadowDetectionRepository.record(
          buildYoungAccountSpendShadowDetection({ spender, rank: index + 1, summary, thresholds, window })
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
