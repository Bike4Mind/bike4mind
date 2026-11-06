/**
 * Pays queued gear and referral rewards from the trickle pool (creditService.releaseHeldCreditRewards), then
 * held signup grants from the signup pool, oldest first, then due payment unlocks (userService.releaseDueHeldUnlocks),
 * then approves pending risk reviews whose auto-approval evidence now holds (riskReviewAutoApproval.ts).
 * Schedule: hourly (infra/cron.ts signupGrantHeldRelease), so the day's first run drains the backlog.
 * Self-host equivalent: apps/workers/src/selfhost/signupGrantHeldRelease.ts.
 */
import { connectDB, signupGrantReleaseRepository } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { creditService, userService } from '@bike4mind/services';
import { Config } from '@bike4mind/server-utils/utils/config';
import { Resource } from 'sst';
import { buildHeldGrantAdapters } from '@server/credits/heldSignupGrantAdapters';
import { buildCreditRewardAdapters } from '@server/credits/creditRewardAdapters';
import { alertForReleasedReferralRewards } from '@server/referrals/firstAnswerReward';
import {
  sweepRiskReviewAutoApprovals,
  type RiskReviewAutoApprovalSweepResult,
} from '@server/security/riskReviewAutoApproval';

const logger = new Logger({ metadata: { service: 'signupGrantHeldRelease' } });
const MAX_USERS_PER_RUN = 500;

export async function runSignupGrantHeldRelease(now: Date = new Date()): Promise<
  userService.HeldReleaseCronResult & {
    heldUnlocks: userService.HeldUnlockReleaseResult;
    riskReviewAutoApprovals: RiskReviewAutoApprovalSweepResult;
  }
> {
  // Queued gear/referral rewards go first: they are owed from the trickle pool before new drips.
  // A failure here must not stall the held signup grants and unlocks below.
  try {
    const rewards = await creditService.releaseHeldCreditRewards(
      { ...buildCreditRewardAdapters(), logger },
      {
        limit: MAX_USERS_PER_RUN,
      }
    );
    if (rewards.scanned > 0) logger.info('[signupGrantHeldRelease] held rewards done', rewards);
    try {
      await alertForReleasedReferralRewards(
        rewards.paidRewards
          .filter(paid => paid.source === 'referral_first_answer')
          .map(paid => paid.creditTransactionId)
      );
    } catch (error) {
      // The payouts above have committed; only the post-payout spend check failed.
      logger.error('[signupGrantHeldRelease] referral spend alert failed after paying held rewards', error);
    }
  } catch (error) {
    logger.error('[signupGrantHeldRelease] held rewards failed', error);
  }
  const adapters = buildHeldGrantAdapters(logger);
  const result = await userService.releaseHeldGrantsAgainstBudget(
    {
      ...adapters,
      listHeldIds: async input =>
        (await signupGrantReleaseRepository.listHeld({ ...input, reason: 'budget_exhausted', payableOnly: true })).map(
          row => row.id
        ),
    },
    { maxUsers: MAX_USERS_PER_RUN }
  );
  if (result.scanned > 0) logger.info('[signupGrantHeldRelease] done', result);
  const heldUnlocks = await userService.releaseDueHeldUnlocks(
    { ...adapters.grant, listDueIds: input => signupGrantReleaseRepository.listDueHeldUnlocks(input) },
    { now, maxUsers: MAX_USERS_PER_RUN }
  );
  if (heldUnlocks.scanned > 0) logger.info('[signupGrantHeldRelease] held unlocks done', heldUnlocks);
  let riskReviewAutoApprovals: RiskReviewAutoApprovalSweepResult = { scanned: 0, approved: 0, failed: 0 };
  try {
    riskReviewAutoApprovals = await sweepRiskReviewAutoApprovals(logger, { maxUsers: MAX_USERS_PER_RUN, now });
    if (riskReviewAutoApprovals.scanned > 0)
      logger.info('[signupGrantHeldRelease] risk review auto-approvals done', riskReviewAutoApprovals);
  } catch (error) {
    logger.error('[signupGrantHeldRelease] risk review auto-approvals failed', error);
  }
  return { ...result, heldUnlocks, riskReviewAutoApprovals };
}

export const handler = async () => {
  await connectDB(Config.MONGODB_URI.replace('%STAGE%', Resource.App.stage));
  return runSignupGrantHeldRelease();
};
