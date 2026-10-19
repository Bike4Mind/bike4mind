import { IFabFileRepository, IUserRepository } from '@bike4mind/common';
import { reconcileStorageCounter, StorageReconciliationRepair } from '../lib/reconcileStorageCounter';

export interface ReconcileUserStorageAdapters {
  db: {
    users: Pick<IUserRepository, 'findCurrentStorageSize' | 'setCurrentStorageIfUnchanged'>;
    fabFiles: Pick<IFabFileRepository, 'sumFileSizeByUserId'>;
  };
}

export interface UserStorageReconciliation {
  userId: string;
  counter: number;
  truth: number;
  /** counter - truth, in bytes. */
  drift: number;
  repaired: boolean;
  /** The counter moved between being read and the repair, so nothing was written. */
  conflict: boolean;
}

/**
 * Compares a user's storage counter with the bytes their charged files hold and, when `repair` allows
 * it, sets the counter to that truth by compare-and-set on the value read just before the aggregate.
 * A charge or refund whose counter write lands after that read loses nothing: the write is skipped.
 *
 * The CAS cannot see an adjustment split across two writes, where the file row changed but the counter
 * write has not run yet: a refund's delete before its debit (the repair then leaves the counter low) or
 * a stamp before its deferred charge, e.g. chargeStampedKnowledgeStorage (the repair then double-charges).
 * Callers that repair unattended should only do so for drift that has held still across checks.
 * Returns null when the user does not exist.
 */
export const reconcileUserStorage = async (
  { userId, repair }: { userId: string; repair: StorageReconciliationRepair },
  { db }: ReconcileUserStorageAdapters
): Promise<UserStorageReconciliation | null> => {
  const outcome = await reconcileStorageCounter(
    {
      readCounter: () => db.users.findCurrentStorageSize(userId),
      readTruth: () => db.fabFiles.sumFileSizeByUserId(userId),
      setIfUnchanged: (expected, next) => db.users.setCurrentStorageIfUnchanged(userId, expected, next),
    },
    repair
  );
  return outcome && { userId, ...outcome };
};
