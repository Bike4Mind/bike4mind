import { CreditHolderType, settingsMap } from '@bike4mind/common';
import {
  adminSettingsRepository,
  CreditTransaction,
  creditLotRepository,
  creditTransactionRepository,
  User,
  userRepository,
} from '@bike4mind/database';
import { creditService } from '@bike4mind/services';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { postMessageToSlack } from '@server/integrations/slack/slack';
import { Logger } from '@bike4mind/observability';

export const REFERRAL_REWARD_REASON = 'referral_reward';

const DAY_MS = 24 * 60 * 60 * 1000;

type RewardParty = {
  isSynthetic?: boolean | null;
  deletedAt?: Date | null;
  moderation?: { status?: string } | null;
};

const isBlockedInviter = (inviter: RewardParty) =>
  !!inviter.deletedAt ||
  !!inviter.isSynthetic ||
  inviter.moderation?.status === 'suspended' ||
  inviter.moderation?.status === 'suspend_pending';

/**
 * Pays the inviter once their friend has both a first answer and a verified email. Called from both
 * events (recordFirstValue and emitEmailVerifiedFunnelEvents) and re-reads the friend, so whichever
 * lands last pays and the order never matters. The stable transactionId makes a repeat or concurrent
 * call a no-op. Dormant while ReferralFirstAnswerCredits is 0. Never throws.
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
      { names: ['ReferralFirstAnswerCredits', 'ReferralAlertRewardsPerDay'], skipCache: true }
    );
    const amount = getSettingsValue('ReferralFirstAnswerCredits', settings, 0);
    if (!(amount > 0)) return;

    const inviterId = String(friend.referredByUserId);
    const inviter = await User.findById(inviterId)
      .select('isSynthetic deletedAt moderation.status')
      .lean<RewardParty>();
    if (!inviter || isBlockedInviter(inviter)) return;

    const { creditTransactionId } = await creditService.addCreditsWithLedgerRow(
      {
        ownerId: inviterId,
        ownerType: CreditHolderType.User,
        credits: amount,
        type: 'generic_add',
        transactionId: `referral-first-answer:${inviterId}:${friendId}`,
        reason: REFERRAL_REWARD_REASON,
        description: 'Referral reward: first answer from an invited friend',
        metadata: { step: 'first_answer', referredUserId: friendId },
      },
      {
        db: { creditTransactions: creditTransactionRepository, creditLots: creditLotRepository },
        creditHolderMethods: userRepository,
      }
    );
    if (!creditTransactionId) return;

    await alertIfRewardsSpike(
      creditTransactionId,
      getSettingsValue(
        'ReferralAlertRewardsPerDay',
        settings,
        settingsMap.ReferralAlertRewardsPerDay.schema.parse(undefined)
      )
    );
  } catch (err) {
    Logger.error('[referral] first-answer reward failed', err, { friendId });
  }
}

// Only the reward that crosses the threshold alerts. Each reward ranks itself by _id order instead of
// reading a shared total, so payouts committing together cannot both skip the crossing: a race can
// duplicate the alert but never drop it.
async function alertIfRewardsSpike(transactionId: string, threshold: number): Promise<void> {
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
