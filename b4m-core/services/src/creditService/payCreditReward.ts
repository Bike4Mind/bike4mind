import {
  CreditHolderType,
  isSignupGrantBlocked,
  type IAdminSettingsRepository,
  type SignupGrant,
  type SignupProtection,
} from '@bike4mind/common';
import { accountBlockReasons, type AccountStateFields } from '../userService/accountState';
import {
  drawnInRefundScope,
  queueHeadBlocks,
  reserveSignupGrantBudget,
  resolvePoolBudget,
} from '../userService/signupGrantBudget';
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

/** `paused` is a blocked account's reward, out of the queue until unblock restores it to `held`. */
export type HeldCreditRewardRow = HeldCreditRewardInput & {
  status: 'held' | 'paid' | 'void' | 'paused';
  heldAt: Date;
};

/** Implemented by heldCreditRewardRepository in packages/database (models/billing/HeldCreditRewardModel.ts). */
export interface HeldCreditRewardRepository {
  hold(reward: HeldCreditRewardInput): Promise<void>;
  findByTransactionIds(transactionIds: string[]): Promise<HeldCreditRewardRow[]>;
  /** Credits of the oldest held reward of at most `maxCredits`, or null when none is queued. */
  oldestHeldCredits(maxCredits?: number): Promise<number | null>;
  /** Oldest held rewards first; `maxCredits` leaves out rewards larger than that (a whole day's pool). */
  listHeld(limit: number, maxCredits?: number): Promise<HeldCreditRewardRow[]>;
  settle(transactionId: string, status: 'paid' | 'void'): Promise<void>;
  /** Moves a user's held rewards out of the queue; returns how many moved. */
  pauseForUser(userId: string): Promise<number>;
  /** Moves one held reward out of the queue, leaving the user's other rows alone; returns how many moved. */
  pauseOne(transactionId: string): Promise<number>;
  /** Puts a user's paused rewards back in the queue at their original place; returns how many moved. */
  resumeForUser(userId: string): Promise<number>;
}

export type RewardPartyFields = AccountStateFields & {
  isSynthetic?: boolean | null;
  deletedAt?: Date | null;
  signupGrant?: Pick<SignupGrant, 'blocked'> | null;
};

/**
 * The money-path account gate, stricter than accountBlockReasons: a deleted, synthetic or
 * suspend_pending account is not paid either. It gates the invited friend of a referral reward on its own;
 * the account a reward pays goes through isRewardRecipientBlocked.
 */
export const isRewardPartyBlocked = (party: RewardPartyFields) =>
  !!party.deletedAt ||
  !!party.isSynthetic ||
  accountBlockReasons(party).length > 0 ||
  party.moderation?.status === 'suspend_pending';

/**
 * isRewardPartyBlocked plus an admin's grant block, for the account a reward pays. Hold time
 * (packages/server-utils/src/referrals/firstAnswerReward.ts, the gears catalog) and release time both use it, so a
 * reward never pays on release what it would have refused up front. It never applies to the invited friend of a
 * referral reward, so blocking a friend cannot hold the inviter's reward in the queue.
 */
export const isRewardRecipientBlocked = (party: RewardPartyFields) =>
  isRewardPartyBlocked(party) || isSignupGrantBlocked(party);

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

/**
 * 'transient' covers states an account can leave (dispute pending, suspension or suspend_pending, both
 * appealable, or an admin grant block on the recipient, which unblock lifts): the release keeps such a reward
 * queued rather than voiding it, which would forfeit it for good.
 */
type PartyBlock = 'terminal' | 'transient' | null;

const partyBlock = (party: RewardPartyFields | null, isRecipient = false): PartyBlock => {
  if (!party || party.deletedAt || party.isSynthetic || party.isBanned) return 'terminal';
  return (isRecipient ? isRewardRecipientBlocked(party) : isRewardPartyBlocked(party)) ? 'transient' : null;
};

async function partiesBlock(reward: HeldCreditRewardInput, adapters: PayCreditRewardAdapters): Promise<PartyBlock> {
  const userBlock = partyBlock(await adapters.users.findById(reward.userId), true);
  if (userBlock === 'terminal') return userBlock;
  const friendId = reward.metadata?.[REFERRED_USER_ID_METADATA_KEY];
  if (reward.source !== 'referral_first_answer' || typeof friendId !== 'string') return userBlock;
  return partyBlock(await adapters.users.findById(friendId)) ?? userBlock;
}

type PayNowResult =
  { status: 'paid'; creditTransactionId: string } | { status: 'exhausted' | 'contended' | 'duplicate' | 'blocked' };

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
  const credit = async () => {
    // Read inside the payout transaction: a block that commits after the caller's check conflicts with this
    // write, and the retry then sees the flag. Without an owned transaction this narrows the window only.
    if (isSignupGrantBlocked((await adapters.users.findById(reward.userId)) ?? {})) return null;
    return addCreditsWithLedgerRow(
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
  };
  try {
    const credited = withTransaction ? await withTransaction(credit) : await credit();
    if (!credited) {
      await reservation.release();
      return { status: 'blocked' };
    }
    const { creditTransactionId } = credited;
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
    // An unreadable ledger keeps the draw: under-counting the pool beats paying a committed row unmetered.
    const committed = await adapters.db.creditTransactions.findOne({ transactionId: reward.transactionId }).then(
      row => !!row,
      readError => {
        adapters.logger?.error('[payCreditReward] could not confirm the ledger row; keeping the draw', readError, {
          transactionId: reward.transactionId,
        });
        return true;
      }
    );
    if (!committed) await reservation.release();
    throw error;
  }
}

/**
 * Pays a free reward (gear, referral) from the trickle pool. A dry pool, or a queued older reward the
 * pool could no longer cover after this one, holds it for releaseHeldCreditRewards; a blocked account
 * gets nothing and nothing is queued, except that a block landing after the queue insert pauses that row.
 * Idempotent on `transactionId`.
 */
export async function payCreditReward(
  reward: HeldCreditRewardInput,
  adapters: PayCreditRewardAdapters
): Promise<PayCreditRewardOutcome> {
  if (await adapters.db.creditTransactions.findOne({ transactionId: reward.transactionId }))
    return { outcome: 'duplicate' };
  if (await partiesBlock(reward, adapters)) return { outcome: 'blocked' };

  const [own] = await adapters.heldRewards.findByTransactionIds([reward.transactionId]);
  // A voided row was refused at release; answering 'duplicate' would read as claimed and loop the user.
  if (own) {
    if (own.status === 'held') return { outcome: 'queued' };
    return { outcome: own.status === 'void' || own.status === 'paused' ? 'blocked' : 'duplicate' };
  }

  if (
    drawnInRefundScope(adapters, 'trickle', reward.transactionId) ||
    !(await queueHeadBlocks(adapters, 'trickle', adapters.heldRewards, reward.credits))
  ) {
    const paid = await payNow(reward, adapters);
    if (paid.status === 'paid') return { outcome: 'paid', creditTransactionId: paid.creditTransactionId };
    if (paid.status === 'duplicate') return { outcome: 'duplicate' };
    if (paid.status === 'blocked') return { outcome: 'blocked' };
    // 'contended': another attempt holds today's draw and may still fail or have died before paying, so
    // queue rather than answer duplicate; the release settles the row once that attempt's ledger row exists.
  }
  await adapters.heldRewards.hold(reward);
  // A block can commit between the check above and this insert, after its pause already ran; the flag is
  // read again once the row exists, so either that pause or this one takes it out of the queue.
  if (isSignupGrantBlocked((await adapters.users.findById(reward.userId)) ?? {})) {
    await adapters.heldRewards.pauseOne(reward.transactionId);
    return { outcome: 'blocked' };
  }
  return { outcome: 'queued' };
}

export type ReleaseHeldCreditRewardsResult = {
  scanned: number;
  paid: number;
  voided: number;
  /** Rewards left queued because an account is in a state it can leave (see partyBlock). */
  deferred: number;
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
    deferred: 0,
    failed: 0,
    budgetExhausted: false,
    paidRewards: [],
  };
  // Rewards above the whole daily pool can never pay; scanning them would let enough of them fill the
  // window and starve every payable reward queued behind them.
  const { budget } = await resolvePoolBudget(adapters.adminSettings, 'trickle');
  for (const reward of await adapters.heldRewards.listHeld(limit, budget > 0 ? budget : undefined)) {
    result.scanned++;
    try {
      if (await adapters.db.creditTransactions.findOne({ transactionId: reward.transactionId })) {
        await adapters.heldRewards.settle(reward.transactionId, 'paid');
        continue;
      }
      const block = await partiesBlock(reward, adapters);
      if (block === 'transient') {
        result.deferred++;
        continue;
      }
      if (block === 'terminal') {
        await adapters.heldRewards.settle(reward.transactionId, 'void');
        result.voided++;
        continue;
      }
      const paid = await payNow(reward, adapters);
      if (paid.status === 'exhausted') {
        // A reward above the whole daily budget never fits; stopping at it would starve the queue behind it.
        // The scan already leaves those out; this covers a pool lowered while the run is under way.
        const { budget: current } = await resolvePoolBudget(adapters.adminSettings, 'trickle');
        if (current > 0 && reward.credits > current) continue;
        result.budgetExhausted = true;
        break;
      }
      // Another attempt owns today's draw; it settles the row, or a later run retries.
      if (paid.status === 'contended') continue;
      // Blocked after the check above; the row stays queued like any other transient block.
      if (paid.status === 'blocked') {
        result.deferred++;
        continue;
      }
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
