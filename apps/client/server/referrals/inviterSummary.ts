import { CreditHolderType } from '@bike4mind/common';
import {
  adminSettingsRepository,
  CREDIT_BALANCE_EVENT_TYPES,
  CreditTransaction,
  referralSubscriptionRewardRepository,
  User,
} from '@bike4mind/database';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { REFERRAL_REWARD_REASON } from './firstAnswerReward';

const DAY_MS = 24 * 60 * 60 * 1000;

// Matches the 90-day lot a generic_add grant gets in creditService/stampCreditLot.ts; keep the two in sync.
const REWARD_LOT_DAYS = 90;

// How far back a usable reward still produces a notice.
const NOTICE_WINDOW_DAYS = 14;
const MAX_RECENT_REWARDS = 10;

const REWARD_AMOUNT_SETTINGS = [
  'ReferralFirstAnswerCredits',
  'ReferralFirstPaymentCredits',
  'ReferralSecondPaymentCredits',
] as const;

export interface InviterRecentReward {
  id: string;
  credits: number;
  grantedAt: string;
  expiresAt: string;
}

export interface InviterSummary {
  /** False while all three reward amounts are 0: the screen and the notices stay hidden. */
  enabled: boolean;
  invited: number;
  active: number;
  subscribed: number;
  creditsEarned: number;
  recentRewards: InviterRecentReward[];
}

const EMPTY_SUMMARY: InviterSummary = {
  enabled: false,
  invited: 0,
  active: 0,
  subscribed: 0,
  creditsEarned: 0,
  recentRewards: [],
};

/**
 * What an inviter sees about the friends they invited. A reward only shows up once it is usable: a held
 * subscription reward has no ledger row yet, and it is not in the totals either. Everything is read from
 * the ledger (credits earned = rewards granted minus rewards taken back), so first-answer and subscription
 * rewards are treated alike. Returns the empty, disabled summary while all three reward amounts are 0.
 */
export async function getInviterSummary(inviterId: string, now = new Date()): Promise<InviterSummary> {
  const settings = await getSettingsMap(
    { adminSettings: adminSettingsRepository },
    { names: [...REWARD_AMOUNT_SETTINGS], skipCache: true }
  );
  const enabled = REWARD_AMOUNT_SETTINGS.some(name => getSettingsValue(name, settings, 0) > 0);
  if (!enabled) return EMPTY_SUMMARY;

  // Same friend filter the first-answer reward applies, so "active" matches what pays out.
  const friends = { referredByUserId: inviterId, isSynthetic: { $ne: true }, deletedAt: null };
  // Repeating the balance-event type list lets these reads use the partial credit_tx_owner_balance_events
  // index instead of walking the inviter's usage rows.
  const ownLedger = {
    ownerId: inviterId,
    ownerType: CreditHolderType.User,
    type: { $in: [...CREDIT_BALANCE_EVENT_TYPES] },
  };

  const [invited, active, subscribed, totals, recent] = await Promise.all([
    User.countDocuments(friends),
    User.countDocuments({ ...friends, emailVerified: true, firstValueAt: { $ne: null } }),
    referralSubscriptionRewardRepository.countSubscribedFriends(inviterId),
    CreditTransaction.aggregate<{ _id: string; total: number }>([
      { $match: { ...ownLedger, reason: { $in: [REFERRAL_REWARD_REASON, 'referral_reward_takeback'] } } },
      { $group: { _id: '$reason', total: { $sum: { $abs: '$credits' } } } },
    ]),
    CreditTransaction.find({
      ...ownLedger,
      reason: REFERRAL_REWARD_REASON,
      createdAt: { $gte: new Date(now.getTime() - NOTICE_WINDOW_DAYS * DAY_MS) },
    })
      .sort({ createdAt: -1 })
      .limit(MAX_RECENT_REWARDS)
      .select('credits createdAt')
      .lean<Array<{ _id: { toString(): string }; credits: number; createdAt: Date }>>(),
  ]);

  const granted = totals.find(row => row._id === REFERRAL_REWARD_REASON)?.total ?? 0;
  const takenBack = totals.find(row => row._id === 'referral_reward_takeback')?.total ?? 0;

  return {
    enabled: true,
    invited,
    active,
    subscribed,
    creditsEarned: Math.max(0, granted - takenBack),
    recentRewards: recent.map(row => ({
      id: row._id.toString(),
      credits: Math.abs(row.credits),
      grantedAt: row.createdAt.toISOString(),
      expiresAt: new Date(row.createdAt.getTime() + REWARD_LOT_DAYS * DAY_MS).toISOString(),
    })),
  };
}
