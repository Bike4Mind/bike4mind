import {
  CreditHolderType,
  PENDING_FREE_CREDITS_TAG,
  type ICreditTransactionRepository,
  type IUserDocument,
  type ISignupRiskScore,
  type IUserRepository,
  type SignupGrant,
  type SignupGrantAssessment,
  type SignupRiskReviewState,
} from '@bike4mind/common';
import type { FreeCreditAdapters } from './freeCredits';
import { releasePendingFreeCredits } from './freeCredits';
import { classifySignupGrantAction } from './signupGrantActionClassifier';

export const MAX_BULK_RELEASE = 100;

/** The account fields a release changes, as they were just before it, so a revoke can put the account back in the queue. */
export type HeldReleaseRestore = {
  signupGrant: SignupGrant | null;
  signupGrantHeldReason: 'budget_exhausted' | 'risk_review' | null;
  signupGrantHeldAt: Date | null;
  pendingCreditGrant: number | null;
  riskScore: ISignupRiskScore | null;
  signupGrantAssessment: SignupGrantAssessment | null;
};

/** Batches saved before the assessment was snapshotted kept only the review state. */
type LegacyHeldReleaseRestore = Omit<HeldReleaseRestore, 'riskScore' | 'signupGrantAssessment'> & {
  riskReviewState: SignupRiskReviewState | null;
};

export type HeldReleaseEntry = {
  userId: string;
  outcome: 'released' | 'not_held' | 'withheld' | 'failed';
  credits: number;
  reversed?: boolean;
  /** Absent on batches released before revoke restored the hold; those revokes only take the credits back. */
  restore?: HeldReleaseRestore | LegacyHeldReleaseRestore;
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
    if (!classifySignupGrantAction(user, 'release_held').eligible) return none('withheld');
    const restore: HeldReleaseRestore = {
      signupGrant: user.signupGrant ?? null,
      signupGrantHeldReason: user.signupGrantHeldReason ?? null,
      signupGrantHeldAt: user.signupGrantHeldAt ?? null,
      pendingCreditGrant: user.pendingCreditGrant ?? null,
      riskScore: user.riskScore ?? null,
      signupGrantAssessment: user.signupGrantAssessment ?? null,
    };
    const result = await releasePendingFreeCredits(
      { id: userId, tags: [...user.tags], pendingCreditGrant: user.pendingCreditGrant ?? null },
      { ...adapters.grant, bypassBudget }
    );
    if (result.failed) return none('failed');
    if (!result.released) return none('withheld', !!result.budgetExhausted);
    // The payout has committed, so the entry must stay 'released' with its credits for revoke to see it.
    try {
      // Blocked accounts were kept held above; a zero payout here is final (already paid, or the inbox's
      // grant went to another account), so the hold is dropped rather than left to clog the cron queue.
      if (result.creditsGranted <= 0) await users.update({ id: userId, signupGrantHeldReason: null });
      // The credits landed under an idempotent transactionId, so a failed tag clear is retried by re-releasing.
      await adapters.clearPending(userId);
    } catch (error) {
      adapters.grant.logger.error(`Held signup grant for user ${userId} paid but its hold was not cleared`, error);
    }
    return { entry: { userId, outcome: 'released', credits: result.creditsGranted, restore }, budgetExhausted: false };
  } catch (error) {
    adapters.grant.logger.error(`Held signup grant release failed for user ${userId}`, error);
    return none('failed');
  }
}

/** Pays one held grant now under its original transaction id, outside the daily budget. */
export async function releaseHeldGrantNow(userId: string, adapters: HeldGrantAdapters): Promise<HeldReleaseEntry> {
  return (await releaseHeldGrant(userId, adapters, true)).entry;
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
  return { batchId: batch.id, results: entries.map(({ restore: _restore, ...result }) => result) };
}

export type RevokeOutcome = 'reversed' | 'already_reversed' | 'insufficient_balance' | 'state_changed' | 'failed';

// A reversed payout leaves the verify-grant id, which would otherwise block the account's next release. The new id
// must not match the SIGNUP_GRANT_TRANSACTION_ID prefixes (bulkAbuseResponse.ts) or the credits would be clawed twice.
const reversedGrantTransactionId = (userId: string, batchId: string) => `reversed-signup-grant:${userId}:${batchId}`;

/** True while the account still shows exactly what the release left, so restoring cannot clobber later grants. */
function releaseStillCurrent(
  current: { signupGrant?: SignupGrant },
  restore: HeldReleaseEntry['restore'] & object,
  credits: number
) {
  if (!restore.signupGrant) return !current.signupGrant;
  return current.signupGrant?.creditsReleased === restore.signupGrant.creditsReleased + credits;
}

type RevokeUsers = Pick<
  IUserRepository,
  'incrementCredits' | 'findById' | 'restoreReleasedGrantState' | 'addTagsToUser'
> & {
  /** Atomic debit applied only when the balance covers all of `credits`. */
  decrementCreditsIfCovered: (userId: string, credits: number) => Promise<boolean>;
};

/** The tag goes last: the queue lists an account by its tag, so it must not appear before the rest is back. */
async function restoreHeldState(
  userId: string,
  restore: NonNullable<HeldReleaseEntry['restore']>,
  credits: number,
  current: Pick<IUserDocument, 'riskScore'>,
  users: RevokeUsers
) {
  const set: Parameters<RevokeUsers['restoreReleasedGrantState']>[1]['set'] = {
    ...(restore.signupGrant ? { signupGrant: restore.signupGrant } : {}),
    signupGrantHeldReason: restore.signupGrantHeldReason,
    signupGrantHeldAt: restore.signupGrantHeldAt,
    pendingCreditGrant: restore.pendingCreditGrant,
  };
  const unset: Parameters<RevokeUsers['restoreReleasedGrantState']>[1]['unset'] = [];
  if ('riskScore' in restore) {
    if (restore.riskScore) set.riskScore = restore.riskScore;
    else unset.push('riskScore');
    if (restore.signupGrantAssessment) set.signupGrantAssessment = restore.signupGrantAssessment;
    else unset.push('signupGrantAssessment');
  } else if (
    current.riskScore &&
    restore.riskReviewState &&
    current.riskScore.reviewState !== restore.riskReviewState
  ) {
    set.riskScore = { ...current.riskScore, reviewState: restore.riskReviewState };
  }
  const restored = await users.restoreReleasedGrantState(userId, {
    creditsReleased: restore.signupGrant ? restore.signupGrant.creditsReleased + credits : null,
    set,
    unset,
  });
  if (!restored) throw new Error(`User ${userId} changed after the release; held state not restored`);
  await users.addTagsToUser(userId, [PENDING_FREE_CREDITS_TAG]);
}

/**
 * Reverses a release: takes back the credits it paid and, when the batch kept the pre-release account, puts the
 * account back in the held queue. A balance already spent, or an account granted more since, is left alone.
 */
export async function revokeHeldGrantRelease(
  input: { batchId: string; actorId: string },
  adapters: {
    batches: HeldReleaseBatchRepository;
    users: RevokeUsers;
    creditTransactions: ICreditTransactionRepository;
    logger: { error: (message: string, ...args: unknown[]) => void };
  }
) {
  const batch = await adapters.batches.findBatch(input.batchId);
  if (!batch) return null;
  // heldRestored marks a reversal that also returned the account to the queue; batches without a saved state only debit.
  const results: { userId: string; outcome: RevokeOutcome; credits: number; heldRestored?: true }[] = [];
  for (const entry of batch.entries) {
    if (entry.outcome !== 'released' || entry.credits <= 0) continue;
    const row = (outcome: RevokeOutcome, heldRestored = false) =>
      results.push({
        userId: entry.userId,
        outcome,
        credits: entry.credits,
        ...(heldRestored ? { heldRestored } : {}),
      });
    if (!(await adapters.batches.claimReversal(batch.id, entry.userId))) {
      row('already_reversed');
      continue;
    }
    // Credits taken from the balance and not yet restored or covered by a ledger row.
    let outstanding = 0;
    // The debit and its ledger row are both written; only the account restore can still fail.
    let ledgerWritten = false;
    try {
      const current = entry.restore ? await adapters.users.findById(entry.userId) : null;
      if (entry.restore && (!current || !releaseStillCurrent(current, entry.restore, entry.credits))) {
        await adapters.batches.unclaimReversal(batch.id, entry.userId);
        row('state_changed');
        continue;
      }
      if (!(await adapters.users.decrementCreditsIfCovered(entry.userId, entry.credits))) {
        await adapters.batches.unclaimReversal(batch.id, entry.userId);
        row('insufficient_balance');
        continue;
      }
      outstanding = entry.credits;
      try {
        await adapters.creditTransactions.createTransaction('generic_deduct', {
          ownerId: entry.userId,
          ownerType: CreditHolderType.User,
          credits: -entry.credits,
          reason: 'admin_adjustment',
          description: 'Revoked a released signup grant',
          metadata: { actorId: input.actorId, releaseBatchId: batch.id },
        });
      } catch (error) {
        await adapters.users.incrementCredits(entry.userId, entry.credits);
        outstanding = 0;
        throw error;
      }
      outstanding = 0;
      ledgerWritten = true;
      if (entry.restore && current) {
        await adapters.creditTransactions.rekeyTransaction(
          `verify-grant:${entry.userId}`,
          reversedGrantTransactionId(entry.userId, batch.id)
        );
        await restoreHeldState(entry.userId, entry.restore, entry.credits, current, adapters.users);
      }
      row('reversed', !!entry.restore);
    } catch (error) {
      // Unclaiming an uncompensated debit would let a retry debit the same grant twice.
      if (outstanding > 0) {
        adapters.logger.error(
          `Reversal for user ${entry.userId} debited ${outstanding} credits with no ledger row; entry left claimed for manual repair`,
          error
        );
      } else if (ledgerWritten) {
        adapters.logger.error(
          `Reversal for user ${entry.userId} took the credits back but did not restore the held grant; entry left claimed for manual repair`,
          error
        );
      } else {
        await adapters.batches.unclaimReversal(batch.id, entry.userId);
        adapters.logger.error(`Reversal failed for user ${entry.userId}`, error);
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
  /** Still held for a reason other than the budget, e.g. a blocked or revoked account. */
  withheld: number;
  /** No longer held when reached. */
  skipped: number;
  failed: number;
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
  const result: HeldReleaseCronResult = {
    scanned: 0,
    released: 0,
    creditsPaid: 0,
    withheld: 0,
    skipped: 0,
    failed: 0,
    stoppedOnBudget: false,
  };
  let afterId: string | undefined;
  while (result.scanned < options.maxUsers) {
    const ids = await adapters.listHeldIds({ afterId, limit: Math.min(pageSize, options.maxUsers - result.scanned) });
    if (!ids.length) break;
    for (const id of ids) {
      result.scanned++;
      const { entry, budgetExhausted } = await releaseHeldGrant(id, adapters, false);
      if (budgetExhausted) {
        result.stoppedOnBudget = true;
        return result;
      }
      if (entry.outcome === 'released') {
        result.released++;
        result.creditsPaid += entry.credits;
      } else if (entry.outcome === 'withheld') result.withheld++;
      else if (entry.outcome === 'not_held') result.skipped++;
      else result.failed++;
    }
    afterId = ids[ids.length - 1];
  }
  return result;
}
