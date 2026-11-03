import { CreditHolderType, type IAdminSettingsRepository, type SignupProtection } from '@bike4mind/common';
import { accountBlockReasons, type AccountStateFields } from '../userService/accountState';
import { queueHeadBlocks, reserveSignupGrantBudget, resolvePoolBudget } from '../userService/signupGrantBudget';
import { addCreditsWithLedgerRow, DuplicateCreditTransactionError, type AddCreditsAdapters } from './addCredits';

export type CreditRewardSource = 'gear' | 'referral_first_answer';

/** `source` is stamped on the ledger row as metadata.rewardSource; `reason` keeps each caller's existing label. */
export type HeldCreditRewardInput = {
  transactionId: string;
  userId: string;
  credits: number;
  source: CreditRewardSource;
  reason: string;
  description: string;
  metadata?: Record<string, unknown>;
};

export type HeldCreditRewardRow = HeldCreditRewardInput & { status: 'held' | 'paid' | 'void'; heldAt: Date };

/** Implemented by heldCreditRewardRepository in packages/database (models/billing/HeldCreditRewardModel.ts). */
export interface HeldCreditRewardRepository {
  hold(reward: HeldCreditRewardInput): Promise<void>;
  findByTransactionIds(transactionIds: string[]): Promise<HeldCreditRewardRow[]>;
  /** Credits of the oldest held reward of at most `maxCredits`, or null when none is queued. */
  oldestHeldCredits(maxCredits?: number): Promise<number | null>;
  listHeld(limit: number): Promise<HeldCreditRewardRow[]>;
  settle(transactionId: string, status: 'paid' | 'void'): Promise<void>;
}

export type RewardPartyFields = AccountStateFields & { isSynthetic?: boolean | null; deletedAt?: Date | null };

/**
 * The money-path account gate, stricter than accountBlockReasons: a deleted, synthetic or
 * suspend_pending account is not paid either. Hold time (apps/client/server/referrals/firstAnswerReward.ts)
 * and release time both use it, so a reward never pays on release what it would have refused up front.
 */
export const isRewardPartyBlocked = (party: RewardPartyFields) =>
  !!party.deletedAt ||
  !!party.isSynthetic ||
  accountBlockReasons(party).length > 0 ||
  party.moderation?.status === 'suspend_pending';

/** Metadata key naming the invited friend on a referral reward; that friend is re-checked before paying. */
export const REFERRED_USER_ID_METADATA_KEY = 'referredUserId';

export type PayCreditRewardAdapters = AddCreditsAdapters & {
  heldRewards: HeldCreditRewardRepository;
  users: { findById(id: string): Promise<RewardPartyFields | null> };
  adminSettings: Pick<IAdminSettingsRepository, 'findBySettingName'>;
  signupProtection?: SignupProtection;
  logger?: { error(message: string, ...context: unknown[]): void };
  /**
   * Commits each payout's ledger row and balance credit together. Omit only when the caller already
   * runs payCreditReward inside a transaction (the gear claim route).
   */
  withTransaction?: <T>(fn: () => Promise<T>) => Promise<T>;
};

export type PayCreditRewardOutcome =
  { outcome: 'paid'; creditTransactionId: string } | { outcome: 'queued' | 'duplicate' | 'blocked' };

async function partiesBlocked(reward: HeldCreditRewardInput, adapters: PayCreditRewardAdapters) {
  const user = await adapters.users.findById(reward.userId);
  if (!user || isRewardPartyBlocked(user)) return true;
  const friendId = reward.metadata?.[REFERRED_USER_ID_METADATA_KEY];
  if (reward.source !== 'referral_first_answer' || typeof friendId !== 'string') return false;
  const friend = await adapters.users.findById(friendId);
  return !friend || isRewardPartyBlocked(friend);
}

type PayNowResult =
  { status: 'paid'; creditTransactionId: string } | { status: 'exhausted' | 'contended' | 'duplicate' };

async function payNow(reward: HeldCreditRewardInput, adapters: PayCreditRewardAdapters): Promise<PayNowResult> {
  const reservation = await reserveSignupGrantBudget(adapters, reward.transactionId, reward.credits, {
    pool: 'trickle',
  });
  if (reservation.outcome === 'exhausted') return { status: 'exhausted' };
  // A non-fresh draw belongs to a concurrent attempt (double claim, overlapping cron) that may still pay
  // or refund it; paying here could pay unmetered, and losing its ledger insert would refund its draw.
  if (reservation.outcome === 'reserved' && !reservation.fresh) return { status: 'contended' };
  const { withTransaction } = adapters;
  // A duplicate insert aborts an owned transaction, so it must throw out of it rather than read on.
  const creditAdapters: AddCreditsAdapters = withTransaction
    ? { ...adapters, duplicateTransactionId: 'throw' }
    : adapters;
  const credit = () =>
    addCreditsWithLedgerRow(
      {
        ownerId: reward.userId,
        ownerType: CreditHolderType.User,
        credits: reward.credits,
        type: 'generic_add',
        transactionId: reward.transactionId,
        reason: reward.reason,
        description: reward.description,
        metadata: { ...reward.metadata, rewardSource: reward.source },
      },
      creditAdapters
    );
  try {
    const { creditTransactionId } = withTransaction ? await withTransaction(credit) : await credit();
    if (!creditTransactionId) {
      await reservation.release();
      return { status: 'duplicate' };
    }
    return { status: 'paid', creditTransactionId };
  } catch (error) {
    if (withTransaction && error instanceof DuplicateCreditTransactionError) {
      await reservation.release();
      return { status: 'duplicate' };
    }
    // The draw stays spent only for a ledger row that committed; a rolled-back one hands it back here,
    // or via refundBudgetOnFailure when the caller's own transaction rolls back after this returns.
    const committed = await adapters.db.creditTransactions
      .findOne({ transactionId: reward.transactionId })
      .catch(() => null);
    if (!committed) await reservation.release();
    throw error;
  }
}

/**
 * Pays a free reward (gear, referral) from the trickle pool. A dry pool, or a queued older reward the
 * pool could no longer cover after this one, holds it for releaseHeldCreditRewards; a blocked account
 * gets nothing and nothing is queued. Idempotent on `transactionId`.
 */
export async function payCreditReward(
  reward: HeldCreditRewardInput,
  adapters: PayCreditRewardAdapters
): Promise<PayCreditRewardOutcome> {
  if (await adapters.db.creditTransactions.findOne({ transactionId: reward.transactionId }))
    return { outcome: 'duplicate' };
  if (await partiesBlocked(reward, adapters)) return { outcome: 'blocked' };

  const [own] = await adapters.heldRewards.findByTransactionIds([reward.transactionId]);
  // A voided row was refused at release; answering 'duplicate' would read as claimed and loop the user.
  if (own) return { outcome: own.status === 'held' ? 'queued' : own.status === 'void' ? 'blocked' : 'duplicate' };

  if (!(await queueHeadBlocks(adapters, 'trickle', adapters.heldRewards, reward.credits))) {
    const paid = await payNow(reward, adapters);
    if (paid.status === 'paid') return { outcome: 'paid', creditTransactionId: paid.creditTransactionId };
    if (paid.status === 'duplicate') return { outcome: 'duplicate' };
    // 'contended': another attempt holds today's draw and may still fail or have died before paying, so
    // queue rather than answer duplicate; the release settles the row once that attempt's ledger row exists.
  }
  await adapters.heldRewards.hold(reward);
  return { outcome: 'queued' };
}

export type ReleaseHeldCreditRewardsResult = {
  scanned: number;
  paid: number;
  voided: number;
  /** Rewards whose release threw; they stay held for the next run. */
  failed: number;
  budgetExhausted: boolean;
  /** Ledger ids of the rewards this run paid, so callers can run their post-payout checks. */
  paidRewards: Array<{ source: CreditRewardSource; creditTransactionId: string }>;
};

/** Pays queued rewards oldest first against today's trickle pool, stopping at the first that does not fit. */
export async function releaseHeldCreditRewards(
  adapters: PayCreditRewardAdapters,
  { limit }: { limit: number }
): Promise<ReleaseHeldCreditRewardsResult> {
  const result: ReleaseHeldCreditRewardsResult = {
    scanned: 0,
    paid: 0,
    voided: 0,
    failed: 0,
    budgetExhausted: false,
    paidRewards: [],
  };
  for (const reward of await adapters.heldRewards.listHeld(limit)) {
    result.scanned++;
    try {
      if (await adapters.db.creditTransactions.findOne({ transactionId: reward.transactionId })) {
        await adapters.heldRewards.settle(reward.transactionId, 'paid');
        continue;
      }
      if (await partiesBlocked(reward, adapters)) {
        await adapters.heldRewards.settle(reward.transactionId, 'void');
        result.voided++;
        continue;
      }
      const paid = await payNow(reward, adapters);
      if (paid.status === 'exhausted') {
        // A reward above the whole daily budget never fits; stopping at it would starve the queue behind it.
        const { budget } = await resolvePoolBudget(adapters.adminSettings, 'trickle');
        if (budget > 0 && reward.credits > budget) continue;
        result.budgetExhausted = true;
        break;
      }
      // Another attempt owns today's draw; it settles the row, or a later run retries.
      if (paid.status === 'contended') continue;
      await adapters.heldRewards.settle(reward.transactionId, 'paid');
      if (paid.status === 'paid') {
        result.paid++;
        result.paidRewards.push({ source: reward.source, creditTransactionId: paid.creditTransactionId });
      }
    } catch (error) {
      // One bad row must not stall the rest of the queue, or the signup grants the same cron releases.
      result.failed++;
      adapters.logger?.error('[releaseHeldCreditRewards] reward release failed', error, {
        transactionId: reward.transactionId,
      });
    }
  }
  return result;
}
