import { CreditHolderType, type IAdminSettingsRepository, type SignupProtection } from '@bike4mind/common';
import { accountBlockReasons, type AccountStateFields } from '../userService/accountState';
import { reserveSignupGrantBudget } from '../userService/signupGrantBudget';
import { addCreditsWithLedgerRow, type AddCreditsAdapters } from './addCredits';

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
  hasHeld(): Promise<boolean>;
  listHeld(limit: number): Promise<HeldCreditRewardRow[]>;
  settle(transactionId: string, status: 'paid' | 'void'): Promise<void>;
}

export type PayCreditRewardAdapters = AddCreditsAdapters & {
  heldRewards: HeldCreditRewardRepository;
  users: { findById(id: string): Promise<AccountStateFields | null> };
  adminSettings: Pick<IAdminSettingsRepository, 'findBySettingName'>;
  signupProtection?: SignupProtection;
};

export type PayCreditRewardOutcome =
  { outcome: 'paid'; creditTransactionId: string } | { outcome: 'queued' | 'duplicate' | 'blocked' };

async function payNow(reward: HeldCreditRewardInput, adapters: PayCreditRewardAdapters) {
  const reservation = await reserveSignupGrantBudget(adapters, reward.transactionId, reward.credits, {
    pool: 'trickle',
  });
  if (reservation.outcome === 'exhausted') return null;
  try {
    const { creditTransactionId } = await addCreditsWithLedgerRow(
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
      adapters
    );
    if (!creditTransactionId) await reservation.release();
    return creditTransactionId ?? '';
  } catch (error) {
    await reservation.release();
    throw error;
  }
}

/**
 * Pays a free reward (gear, referral) from the trickle pool. A dry pool, or an older reward still
 * queued, holds it for releaseHeldCreditRewards; a blocked account gets nothing and nothing is queued.
 * Idempotent on `transactionId`.
 */
export async function payCreditReward(
  reward: HeldCreditRewardInput,
  adapters: PayCreditRewardAdapters
): Promise<PayCreditRewardOutcome> {
  if (await adapters.db.creditTransactions.findOne({ transactionId: reward.transactionId }))
    return { outcome: 'duplicate' };
  const user = await adapters.users.findById(reward.userId);
  if (!user || accountBlockReasons(user).length > 0) return { outcome: 'blocked' };

  const [own] = await adapters.heldRewards.findByTransactionIds([reward.transactionId]);
  if (own) return { outcome: own.status === 'held' ? 'queued' : 'duplicate' };

  if (!(await adapters.heldRewards.hasHeld())) {
    const creditTransactionId = await payNow(reward, adapters);
    if (creditTransactionId) return { outcome: 'paid', creditTransactionId };
    if (creditTransactionId === '') return { outcome: 'duplicate' };
  }
  await adapters.heldRewards.hold(reward);
  return { outcome: 'queued' };
}

export type ReleaseHeldCreditRewardsResult = {
  scanned: number;
  paid: number;
  voided: number;
  budgetExhausted: boolean;
};

/** Pays queued rewards oldest first against today's trickle pool, stopping at the first that does not fit. */
export async function releaseHeldCreditRewards(
  adapters: PayCreditRewardAdapters,
  { limit }: { limit: number }
): Promise<ReleaseHeldCreditRewardsResult> {
  const result: ReleaseHeldCreditRewardsResult = { scanned: 0, paid: 0, voided: 0, budgetExhausted: false };
  for (const reward of await adapters.heldRewards.listHeld(limit)) {
    result.scanned++;
    if (await adapters.db.creditTransactions.findOne({ transactionId: reward.transactionId })) {
      await adapters.heldRewards.settle(reward.transactionId, 'paid');
      continue;
    }
    const user = await adapters.users.findById(reward.userId);
    if (!user || accountBlockReasons(user).length > 0) {
      await adapters.heldRewards.settle(reward.transactionId, 'void');
      result.voided++;
      continue;
    }
    const creditTransactionId = await payNow(reward, adapters);
    if (creditTransactionId === null) {
      result.budgetExhausted = true;
      break;
    }
    await adapters.heldRewards.settle(reward.transactionId, 'paid');
    if (creditTransactionId) result.paid++;
  }
  return result;
}
