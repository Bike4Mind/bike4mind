import { CreditHolderType, REFERRAL_REWARD_REASON, settingsMap, type SignupGrant } from '@bike4mind/common';
import { buildCreditRewardAdapters } from '../credits/creditRewardAdapters';
import { adminSettingsRepository, CreditTransaction, User } from '@bike4mind/database';
import { creditService } from '@bike4mind/services';
import { isRewardRecipientBlocked, REFERRED_USER_ID_METADATA_KEY } from '@bike4mind/services/creditService';
import type { AccountStateFields } from '@bike4mind/services/userService/accountState';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { postMessageToSlack } from '../integrations/slack/slack';
import { Logger } from '@bike4mind/observability';
import { readReferralMilestones } from './activeFriends';
import { payReachedMilestones } from './milestoneReward';

export { REFERRAL_REWARD_REASON };

/** The reward sources that pay an inviter; their payouts count toward the referral spike alert. */
export const REFERRAL_REWARD_SOURCES: ReadonlySet<string> = new Set([
  'referral_first_answer',
  'referral_subscription',
  'referral_milestone',
]);

const DAY_MS = 24 * 60 * 60 * 1000;

export type RewardParty = {
  isSynthetic?: boolean | null;
  deletedAt?: Date | null;
  signupGrant?: Pick<SignupGrant, 'blocked' | 'unlockForfeited'> | null;
} & AccountStateFields;

// Shared with the release-time gate in creditService.payCreditReward, so a queued reward is never looser.
export const isBlockedInviter = (inviter: RewardParty) => isRewardRecipientBlocked(inviter);

/**
 * Pays the inviter once their friend has both a first answer and a verified email, then any referral
 * milestone that friend brings the inviter to (milestoneReward.ts). Called from both events
 * (recordFirstValue and emitEmailVerifiedFunnelEvents) and re-reads the friend, so whichever lands last
 * pays and the order never matters. Stable transactionIds make a repeat or concurrent call a no-op.
 * Dormant while ReferralFirstAnswerCredits is 0 and ReferralMilestones is empty. Never throws.
 */
export async function rewardInviterForFirstAnswer(friendId: string): Promise<void> {
  try {
    const friend = await User.findById(friendId)
      .select('emailVerified firstValueAt referredByUserId isSynthetic deletedAt')
      .lean<
        {
          emailVerified?: boolean;
          firstValueAt?: Date | null;
          referredByUserId?: string | null;
        } & RewardParty
      >();
    if (!friend?.referredByUserId || !friend.emailVerified || !friend.firstValueAt) return;
    if (friend.isSynthetic || friend.deletedAt) return;

    const settings = await getSettingsMap(
      { adminSettings: adminSettingsRepository },
      { names: ['ReferralFirstAnswerCredits', 'ReferralMilestones', 'ReferralAlertRewardsPerDay'], skipCache: true }
    );
    const amount = getSettingsValue('ReferralFirstAnswerCredits', settings, 0);
    const milestones = readReferralMilestones(getSettingsValue('ReferralMilestones', settings, ''));
    if (!(amount > 0) && milestones.length === 0) return;

    const inviterId = String(friend.referredByUserId);
    const inviter = await User.findById(inviterId)
      .select(
        'isSynthetic deletedAt isBanned disputePending moderation.status signupGrant.blocked signupGrant.unlockForfeited'
      )
      .lean<RewardParty>();
    if (!inviter || isBlockedInviter(inviter)) return;

    const alert = (creditTransactionId: string) => alertIfRewardsSpike(creditTransactionId, spikeThreshold(settings));

    if (amount > 0) {
      // Paid from the trickle pool; a dry pool queues it for the hourly release.
      const result = await creditService.payCreditReward(
        {
          transactionId: `referral-first-answer:${inviterId}:${friendId}`,
          userId: inviterId,
          credits: amount,
          source: 'referral_first_answer',
          reason: REFERRAL_REWARD_REASON,
          description: 'Referral reward: first answer from an invited friend',
          metadata: { step: 'first_answer', [REFERRED_USER_ID_METADATA_KEY]: friendId },
        },
        buildCreditRewardAdapters()
      );
      if (result.outcome === 'paid') await alert(result.creditTransactionId);
    }

    await payReachedMilestones(inviterId, milestones, alert);
  } catch (err) {
    Logger.error('[referral] first-answer reward failed', err, { friendId });
  }
}

const spikeThreshold = (settings: Awaited<ReturnType<typeof getSettingsMap>>) =>
  getSettingsValue(
    'ReferralAlertRewardsPerDay',
    settings,
    settingsMap.ReferralAlertRewardsPerDay.schema.parse(undefined)
  );

/** Runs the spike alert for referral rewards the held-reward release paid (creditService.releaseHeldCreditRewards). */
export async function alertForReleasedReferralRewards(creditTransactionIds: string[]): Promise<void> {
  if (creditTransactionIds.length === 0) return;
  const settings = await getSettingsMap(
    { adminSettings: adminSettingsRepository },
    { names: ['ReferralAlertRewardsPerDay'], skipCache: true }
  );
  const threshold = spikeThreshold(settings);
  for (const id of creditTransactionIds) await alertIfRewardsSpike(id, threshold);
}

// Only the reward ranked one past the threshold alerts. Each reward counts the earlier ones by _id
// instead of reading a shared total, which narrows the race between payouts committing together but
// does not close it: a payout whose smaller-id neighbour has not committed yet undercounts and can
// miss the alert.
export async function alertIfRewardsSpike(transactionId: string, threshold: number): Promise<void> {
  const earlierRewards = await CreditTransaction.countDocuments({
    ownerType: CreditHolderType.User,
    type: 'generic_add',
    reason: REFERRAL_REWARD_REASON,
    createdAt: { $gte: new Date(Date.now() - DAY_MS) },
    _id: { $lt: transactionId },
  });
  if (earlierRewards !== threshold) return;
  await postMessageToSlack(
    `Referral rewards: ${threshold + 1} created in the last 24 hours, above the alert threshold of ${threshold}. ` +
      'Set the referral reward amounts back to 0 in Growth & Pricing to stop them.'
  );
}
