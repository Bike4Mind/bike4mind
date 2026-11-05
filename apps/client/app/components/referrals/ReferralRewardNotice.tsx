import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { useUser } from '@client/app/contexts/UserContext';
import { useGetReferralSummary, type InviterRecentReward } from '@client/app/hooks/data/referralSummary';

const MAX_REMEMBERED_REWARDS = 50;

const storageKey = (userId: string) => `referral-rewards-seen:${userId}`;

// Per device: a reward is announced once on each browser that sees it. Storage can be blocked or cleared,
// in which case the notice falls back to showing again, which is harmless.
const readSeen = (userId: string): string[] => {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(storageKey(userId)) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
};

const writeSeen = (userId: string, ids: string[]) => {
  try {
    window.localStorage.setItem(storageKey(userId), JSON.stringify(ids.slice(-MAX_REMEMBERED_REWARDS)));
  } catch {
    // Storage unavailable: see readSeen.
  }
};

const formatDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

export const rewardNoticeMessage = (rewards: InviterRecentReward[]): string => {
  const total = rewards.reduce((sum, reward) => sum + reward.credits, 0);
  const soonest = rewards.map(reward => reward.expiresAt).sort()[0];
  const subject = rewards.length === 1 ? 'a friend you invited' : `${rewards.length} friends you invited`;
  return `You earned ${total.toLocaleString('en-US')} credits for ${subject}. They are ready to use and expire on ${formatDate(soonest)}.`;
};

/**
 * Announces referral rewards that have become usable. Nothing is rendered. Only accounts that have sent an
 * invite ask the server, and the summary comes back disabled while the reward amounts are 0.
 */
export function ReferralRewardNotice() {
  const currentUser = useUser(s => s.currentUser);
  const userId = currentUser?.id;
  const hasInvited = (currentUser?.regInvites?.length ?? 0) > 0;
  const { data: summary } = useGetReferralSummary({ enabled: !!userId && hasInvited });
  // Backs up storage for this page load, so blocked storage cannot repeat a toast on every refetch.
  const announced = useRef(new Set<string>());

  useEffect(() => {
    if (!userId || !summary?.enabled || summary.recentRewards.length === 0) return;
    const seen = readSeen(userId);
    const unseen = summary.recentRewards.filter(
      reward => !seen.includes(reward.id) && !announced.current.has(reward.id)
    );
    if (unseen.length === 0) return;

    unseen.forEach(reward => announced.current.add(reward.id));
    writeSeen(userId, [...seen, ...unseen.map(reward => reward.id)]);
    toast.success(rewardNoticeMessage(unseen), { duration: 10_000 });
  }, [userId, summary]);

  return null;
}

export default ReferralRewardNotice;
