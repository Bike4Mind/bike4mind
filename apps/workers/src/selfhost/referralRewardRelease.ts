import { releaseDueSubscriptionRewards } from '@server/referrals/subscriptionReward';
import type { SelfHostWorker } from './selfHostWorker';

/** Matches the hosted referralRewardRelease cron's rate(1 hour) in infra/cron.ts; keep them in step. */
export const REFERRAL_REWARD_RELEASE_INTERVAL_MS = 60 * 60_000;

export function registerReferralRewardRelease(worker: Pick<SelfHostWorker, 'registerScheduledTask'>): void {
  worker.registerScheduledTask(
    'referralRewardRelease',
    REFERRAL_REWARD_RELEASE_INTERVAL_MS,
    async () => {
      const result = await releaseDueSubscriptionRewards();
      if (result.failed > 0) throw new Error(`Failed to release ${result.failed} referral reward(s)`);
    },
    // The release date is stored on each reward, so a boot run releases only what the next tick would, sooner.
    { runOnStartup: true }
  );
}
