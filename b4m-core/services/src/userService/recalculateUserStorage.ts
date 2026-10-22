import { ConflictError, IFabFileRepository, IUserRepository } from '@bike4mind/common';
import { NotFoundError, secureParameters } from '@bike4mind/utils';
import { z } from 'zod';
import { reconcileUserStorage, UserStorageReconciliation } from './reconcileUserStorage';

const recalculateUserStorageSchema = z.object({
  /**
   * The user to recalculate the storage for
   */
  userId: z.string(),
});

export type RecalculateUserStorageParameters = z.infer<typeof recalculateUserStorageSchema>;

interface RecalculateUserStorageAdapters {
  db: {
    users: IUserRepository;
    fabFiles: IFabFileRepository;
  };
}

export const RECALCULATE_STORAGE_MAX_ATTEMPTS = 3;

/**
 * Admin repair for one user. Shares reconcileUserStorage's compare-and-set with the scheduled
 * reconciliation (apps/workers/src/cron/storageReconciliation.ts), retrying on a concurrent
 * adjustment instead of overwriting it. Repairs immediately, without the cron's stability check.
 */
export const recalculateUserStorage = async (
  parameters: RecalculateUserStorageParameters,
  { db }: RecalculateUserStorageAdapters
): Promise<UserStorageReconciliation> => {
  const { userId } = secureParameters(parameters, recalculateUserStorageSchema);

  for (let attempt = 0; attempt < RECALCULATE_STORAGE_MAX_ATTEMPTS; attempt++) {
    const result = await reconcileUserStorage({ userId, repair: true }, { db });
    if (!result) throw new NotFoundError(`User ${userId} not found`);
    if (!result.conflict) return result;
  }
  throw new ConflictError(`Storage for user ${userId} kept changing during recalculation; try again`);
};
