import {
  CreditHolderType,
  PENDING_FREE_CREDITS_TAG,
  type ICreditTransactionRepository,
  type IUserRepository,
} from '@bike4mind/common';
import type { FreeCreditAdapters } from './freeCredits';
import { releasePendingFreeCredits } from './freeCredits';
import { accountBlockReasons, isAiAccessRevoked } from './accountState';

export const MAX_BULK_RELEASE = 100;

export type HeldReleaseEntry = {
  userId: string;
  outcome: 'released' | 'not_held' | 'withheld' | 'failed';
  credits: number;
  reversed?: boolean;
};

export type HeldReleaseBatchRepository = {
  createBatch: (input: { actorId: string; entries: HeldReleaseEntry[] }) => Promise<{ id: string }>;
  findBatch: (id: string) => Promise<{ id: string; actorId: string; entries: HeldReleaseEntry[] } | null>;
  claimReversal: (batchId: string, userId: string) => Promise<boolean>;
  unclaimReversal: (batchId: string, userId: string) => Promise<void>;
};

export type HeldGrantAdapters = {
  grant: FreeCreditAdapters & { logger: { error: (message: string, ...args: unknown[]) => void } };
  /** Strips PENDING_FREE_CREDITS_TAG and pendingCreditGrant once a release has paid. */
  clearPending: (userId: string) => Promise<unknown>;
};

type ReleaseOutcome = { entry: HeldReleaseEntry; budgetExhausted: boolean };

async function releaseHeldGrant(
  userId: string,
  adapters: HeldGrantAdapters,
  bypassBudget: boolean
): Promise<ReleaseOutcome> {
  const { users } = adapters.grant.db;
  const none = (outcome: HeldReleaseEntry['outcome'], budgetExhausted = false): ReleaseOutcome => ({
    entry: { userId, outcome, credits: 0 },
    budgetExhausted,
  });
  try {
    const user = await users.findById(userId);
    if (!user || !user.tags?.includes(PENDING_FREE_CREDITS_TAG) || !user.signupGrantHeldReason) return none('not_held');
    if (!user.emailVerified || accountBlockReasons(user).length || isAiAccessRevoked(user)) return none('withheld');
    const result = await releasePendingFreeCredits(
      { id: userId, tags: [...user.tags], pendingCreditGrant: user.pendingCreditGrant ?? null },
      { ...adapters.grant, bypassBudget }
    );
    if (!result.released) return none('withheld', !!result.budgetExhausted);
    // Blocked accounts were kept held above; a zero payout here is final (already paid, or the inbox's
    // grant went to another account), so the hold is dropped rather than left to clog the cron queue.
    if (result.creditsGranted <= 0) await users.update({ id: userId, signupGrantHeldReason: null });
    // The credits landed under an idempotent transactionId, so a failed tag clear is retried by re-releasing.
    await adapters.clearPending(userId);
    return { entry: { userId, outcome: 'released', credits: result.creditsGranted }, budgetExhausted: false };
  } catch (error) {
    adapters.grant.logger.error(`Held signup grant release failed for user ${userId}`, error);
    return none('failed');
  }
}

/** Admin release: pays each held grant under its original transaction id, outside the daily budget. */
export async function bulkReleaseHeldGrants(
  input: { actorId: string; userIds: string[] },
  adapters: HeldGrantAdapters & { batches: HeldReleaseBatchRepository }
) {
  const userIds = [...new Set(input.userIds)].slice(0, MAX_BULK_RELEASE);
  const entries: HeldReleaseEntry[] = [];
  for (const userId of userIds) entries.push((await releaseHeldGrant(userId, adapters, true)).entry);
  const batch = await adapters.batches.createBatch({ actorId: input.actorId, entries });
  return { batchId: batch.id, results: entries };
}

export type UndoOutcome = 'reversed' | 'already_reversed' | 'insufficient_balance' | 'failed';

/** Claws back only the credits an earlier batch released; a balance already spent is left alone. */
export async function undoHeldGrantRelease(
  input: { batchId: string; actorId: string },
  adapters: {
    batches: HeldReleaseBatchRepository;
    users: Pick<IUserRepository, 'findById' | 'incrementCredits'> & {
      /** Atomic debit floored at zero; resolves the credits actually taken. */
      decrementCreditsFloored: (userId: string, credits: number) => Promise<number>;
    };
    creditTransactions: ICreditTransactionRepository;
  }
) {
  const batch = await adapters.batches.findBatch(input.batchId);
  if (!batch) return null;
  const results: { userId: string; outcome: UndoOutcome; credits: number }[] = [];
  for (const entry of batch.entries) {
    if (entry.outcome !== 'released' || entry.credits <= 0) continue;
    const row = (outcome: UndoOutcome) => results.push({ userId: entry.userId, outcome, credits: entry.credits });
    if (!(await adapters.batches.claimReversal(batch.id, entry.userId))) {
      row('already_reversed');
      continue;
    }
    // Credits taken from the balance and not yet restored or covered by a ledger row.
    let outstanding = 0;
    try {
      const user = await adapters.users.findById(entry.userId);
      if (!user || user.currentCredits < entry.credits) {
        await adapters.batches.unclaimReversal(batch.id, entry.userId);
        row('insufficient_balance');
        continue;
      }
      // One atomic floored debit: a balance spent since the check above is never driven negative.
      outstanding = await adapters.users.decrementCreditsFloored(entry.userId, entry.credits);
      if (outstanding < entry.credits) {
        if (outstanding > 0) await adapters.users.incrementCredits(entry.userId, outstanding);
        outstanding = 0;
        await adapters.batches.unclaimReversal(batch.id, entry.userId);
        row('insufficient_balance');
        continue;
      }
      try {
        await adapters.creditTransactions.createTransaction('generic_deduct', {
          ownerId: entry.userId,
          ownerType: CreditHolderType.User,
          credits: -entry.credits,
          reason: 'admin_adjustment',
          description: 'Reversed a released signup grant',
          metadata: { actorId: input.actorId, releaseBatchId: batch.id },
        });
      } catch (error) {
        await adapters.users.incrementCredits(entry.userId, entry.credits);
        outstanding = 0;
        throw error;
      }
      row('reversed');
    } catch (error) {
      // Unclaiming an uncompensated debit would let a retry debit the same grant twice.
      if (outstanding > 0) {
        console.error(
          `[held-signup-grants] Reversal for user ${entry.userId} debited ${outstanding} credits with no ledger row; entry left claimed for manual repair`,
          error
        );
      } else {
        await adapters.batches.unclaimReversal(batch.id, entry.userId);
        console.error(`[held-signup-grants] Reversal failed for user ${entry.userId}`, error);
      }
      row('failed');
    }
  }
  return { batchId: batch.id, results };
}

export type HeldReleaseCronResult = {
  scanned: number;
  released: number;
  creditsPaid: number;
  stoppedOnBudget: boolean;
};

/**
 * Pays held, budget-exhausted grants in creation order against the current day's budget and
 * stops at the first one the budget cannot cover. Blocked or revoked accounts are skipped.
 */
export async function releaseHeldGrantsAgainstBudget(
  adapters: HeldGrantAdapters & {
    listHeldIds: (input: { afterId?: string; limit: number }) => Promise<string[]>;
  },
  options: { maxUsers: number; pageSize?: number }
): Promise<HeldReleaseCronResult> {
  const pageSize = options.pageSize ?? 50;
  const result: HeldReleaseCronResult = { scanned: 0, released: 0, creditsPaid: 0, stoppedOnBudget: false };
  let afterId: string | undefined;
  while (result.scanned < options.maxUsers) {
    const ids = await adapters.listHeldIds({ afterId, limit: Math.min(pageSize, options.maxUsers - result.scanned) });
    if (!ids.length) break;
    for (const id of ids) {
      result.scanned++;
      const user = await adapters.grant.db.users.findById(id);
      if (!user || !user.emailVerified || accountBlockReasons(user).length || isAiAccessRevoked(user)) continue;
      const { entry, budgetExhausted } = await releaseHeldGrant(id, adapters, false);
      if (entry.outcome === 'released') {
        result.released++;
        result.creditsPaid += entry.credits;
      }
      if (budgetExhausted) {
        result.stoppedOnBudget = true;
        return result;
      }
    }
    afterId = ids[ids.length - 1];
  }
  return result;
}
