import { REFERRAL_REWARD_REASON, type ReferralMilestone } from '@bike4mind/common';
import { User } from '@bike4mind/database';
import { creditService } from '@bike4mind/services';
import { buildCreditRewardAdapters } from '../credits/creditRewardAdapters';
import { activeReferredFriendsFilter } from './activeFriends';

export const milestoneTransactionId = (inviterId: string, friends: number) =>
  `referral-milestone:${inviterId}:${friends}`;

/**
 * Pays every milestone the inviter's active friends have reached. Keyed by (inviter, friend count), so a
 * repeat is a no-op and a milestone already paid is not paid again after its amount changes. Run when a
 * friend becomes active; an inviter already past a milestone when it is configured is paid it then.
 * `onPaid` gets each ledger row written now (a queued reward is reported by the held release instead).
 * The caller has already checked the inviter can be paid. Throws on a failed read or write.
 */
export async function payReachedMilestones(
  inviterId: string,
  milestones: readonly ReferralMilestone[],
  onPaid: (creditTransactionId: string) => Promise<void>
): Promise<void> {
  if (milestones.length === 0) return;
  const active = await User.countDocuments(activeReferredFriendsFilter(inviterId));
  for (const milestone of milestones) {
    // Sorted by friend count (parseReferralMilestones), so the first one out of reach ends the run.
    if (milestone.friends > active) break;
    const result = await creditService.payCreditReward(
      {
        transactionId: milestoneTransactionId(inviterId, milestone.friends),
        userId: inviterId,
        credits: milestone.credits,
        source: 'referral_milestone',
        reason: REFERRAL_REWARD_REASON,
        description: `Referral reward: ${milestone.friends} active friends`,
        metadata: { step: 'milestone', milestoneFriends: milestone.friends },
      },
      buildCreditRewardAdapters()
    );
    if (result.outcome === 'paid') await onPaid(result.creditTransactionId);
  }
}
