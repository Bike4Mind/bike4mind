import { CreditHolderType } from '@bike4mind/common';
import {
  adminSettingsRepository,
  CREDIT_BALANCE_EVENT_TYPES,
  CreditTransaction,
  referralSubscriptionRewardRepository,
  User,
} from '@bike4mind/database';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { REFERRAL_REWARD_REASON } from '@bike4mind/server-utils/referrals/firstAnswerReward';

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

interface RecentRewardRow {
  _id: { toString(): string };
  credits: number;
  createdAt: Date;
  metadata?: { invoiceId?: string };
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
 * What an inviter sees about the friends they invited. Credits earned come from the ledger (rewards granted
 * minus rewards taken back), so a held subscription reward, which has no ledger row until released, is not
 * counted; `subscribed` counts friends whose reward is held or released. Returns the empty, disabled
 * summary while all three reward amounts are 0.
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

  const windowStart = new Date(now.getTime() - NOTICE_WINDOW_DAYS * DAY_MS);

  const [invited, active, subscribed, totals, recent, recentTakebacks] = await Promise.all([
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
      createdAt: { $gte: windowStart },
    })
      .sort({ createdAt: -1 })
      .limit(MAX_RECENT_REWARDS)
      .select('credits createdAt metadata.invoiceId')
      .lean<RecentRewardRow[]>(),
    CreditTransaction.find({
      ...ownLedger,
      reason: 'referral_reward_takeback',
      createdAt: { $gte: windowStart },
    })
      .select('credits metadata.invoiceId')
      .lean<Array<{ credits: number; metadata?: { invoiceId?: string } }>>(),
  ]);

  // A subscription reward released and then taken back inside the window must not toast its full amount.
  const takenBackByInvoice = new Map<string, number>();
  for (const row of recentTakebacks) {
    const invoiceId = row.metadata?.invoiceId;
    if (invoiceId) takenBackByInvoice.set(invoiceId, (takenBackByInvoice.get(invoiceId) ?? 0) + Math.abs(row.credits));
  }
  const recentNet = recent
    .map(row => {
      const invoiceId = row.metadata?.invoiceId;
      const credits = Math.abs(row.credits) - (invoiceId ? (takenBackByInvoice.get(invoiceId) ?? 0) : 0);
      return { row, credits };
    })
    .filter(({ credits }) => credits > 0);

  const granted = totals.find(row => row._id === REFERRAL_REWARD_REASON)?.total ?? 0;
  const takenBack = totals.find(row => row._id === 'referral_reward_takeback')?.total ?? 0;

  return {
    enabled: true,
    invited,
    active,
    subscribed,
    creditsEarned: Math.max(0, granted - takenBack),
    recentRewards: recentNet.map(({ row, credits }) => ({
      id: row._id.toString(),
      credits,
      grantedAt: row.createdAt.toISOString(),
      expiresAt: new Date(row.createdAt.getTime() + REWARD_LOT_DAYS * DAY_MS).toISOString(),
    })),
  };
}
