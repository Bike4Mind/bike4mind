/**
 * Credits the inviter's held subscription rewards once their hold has ended. Each reward's claim and grant
 * commit in one transaction with a stable transaction id, so overlapping runs and retries never pay twice.
 * A failed grant rolls the claim back for the next run.
 *
 * Schedule: rate(1 hour) (infra/cron.ts referralRewardRelease).
 * Self-host: apps/workers/src/selfhost/referralRewardRelease.ts.
 */
import { connectDB } from '@bike4mind/database';
import { Config } from '@bike4mind/server-utils/utils/config';
import {
  releaseDueSubscriptionRewards,
  type ReleaseSubscriptionRewardsResult,
} from '@server/referrals/subscriptionReward';
import { Resource } from 'sst';

export async function handler(): Promise<ReleaseSubscriptionRewardsResult> {
  await connectDB(Config.MONGODB_URI.replace('%STAGE%', Resource.App.stage));
  const result = await releaseDueSubscriptionRewards();
  if (result.failed > 0) throw new Error(`Failed to release ${result.failed} referral reward(s)`);
  return result;
}
