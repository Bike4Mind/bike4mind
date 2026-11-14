import { CreditHolderType, type IAdminSettingsRepository } from '@bike4mind/common';
import { generationJobRepository } from '../ai/GenerationJobModel';
import { adminSettingsRepository } from '../infra/ops/AdminSettingsModel';
import { creditTransactionRepository } from './CreditTransactionModel';
import { pendingCreditHoldRepository } from './PendingCreditHoldModel';

/**
 * The deployed adapters for @bike4mind/services' checkNewAccountSpendCap: settled AI usage from the
 * ledger plus the user's holds still outstanding, so concurrent in-flight requests count too. Holds
 * live in two places: PendingCreditHold rows (per-request and image-worker holds) and the creditHold
 * on a queued generation job (image, video, music jobs), which has no PendingCreditHold row.
 * A settled hold is excluded here because its ledger row already counts it.
 */
// Structurally matches NewAccountSpendCapAdapters in @bike4mind/services, which this package cannot import.
type NewAccountSpendCapDbAdapters = {
  adminSettings: Pick<IAdminSettingsRepository, 'findAll' | 'findBySettingNames'>;
  personalSpendSince(userId: string, since: Date): Promise<Array<{ at: Date; credits: number }>>;
};

export const newAccountSpendCapAdapters: NewAccountSpendCapDbAdapters = {
  adminSettings: adminSettingsRepository,
  async personalSpendSince(userId: string, since: Date): Promise<Array<{ at: Date; credits: number }>> {
    const [settled, outstanding, queuedJobs] = await Promise.all([
      creditTransactionRepository.aiSpendByMinuteSince(userId, CreditHolderType.User, since),
      pendingCreditHoldRepository.findOutstandingForUser(userId, since),
      generationJobRepository.findOutstandingHoldsForUser(userId, since),
    ]);
    return [...settled, ...outstanding, ...queuedJobs];
  },
};
