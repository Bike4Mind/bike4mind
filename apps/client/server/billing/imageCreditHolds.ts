import {
  creditTransactionRepository,
  organizationRepository,
  pendingCreditHoldRepository,
  userRepository,
  withTransaction,
} from '@bike4mind/database';
import { creditService } from '@bike4mind/services';
import type { ImageCreditHolds } from '@bike4mind/services/llm/ImageGeneration';
import { CREDIT_HOLD_TTL_MS, settleHeldCredits } from './reserveRequestCredits';

const holdAdapters = {
  users: userRepository,
  organizations: organizationRepository,
  creditTransactions: creditTransactionRepository,
  deductCredits: creditService.deductCreditsWithOrgSupport,
};

/**
 * The image generation / edit queue workers' credit holds. Each hold is recorded as a PendingCreditHold
 * row in the same transaction as the balance move, so a worker that dies mid-render leaves a hold the
 * expired-hold sweep (apps/workers/src/cron/creditHoldSweep.ts) refunds; settle and release claim that
 * row, so exactly one of settle, release and the sweep moves balance.
 */
export const imageCreditHolds: ImageCreditHolds = {
  hold: ({ userId, organizationId, requiredCredits, featureLabel, logger }) =>
    withTransaction(async () => {
      const hold = await creditService.holdCredits(
        { userId, organizationId, requiredCredits, featureLabel, logger },
        holdAdapters
      );
      const pending = await pendingCreditHoldRepository.record(
        hold,
        featureLabel,
        new Date(Date.now() + CREDIT_HOLD_TTL_MS)
      );
      return { ...hold, pendingHoldId: pending.id };
    }),

  // Never throws: it runs on the failure path, and a failed refund is left for the sweep.
  release: async ({ pendingHoldId, ...hold }, { featureLabel, logger }) => {
    try {
      if (!pendingHoldId) {
        await creditService.releaseCreditHold(hold, holdAdapters);
        return;
      }
      const released = await withTransaction(async () => {
        if (!(await pendingCreditHoldRepository.claim(pendingHoldId))) return false;
        await creditService.releaseCreditHold(hold, holdAdapters);
        return true;
      });
      if (!released) logger.warn(`${featureLabel} release found its credit hold already claimed`, { pendingHoldId });
    } catch (error) {
      logger.error(`${featureLabel} credit release failed - left for the expired-hold sweep`, {
        pendingHoldId,
        ownerId: hold.ownerId,
        reservedCredits: hold.reservedCredits,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  },

  settle: (hold, chargedCredits, entry, context) => settleHeldCredits(hold, chargedCredits, entry, context),
};
