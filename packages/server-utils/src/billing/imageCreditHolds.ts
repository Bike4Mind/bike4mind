import { pendingCreditHoldRepository, withTransaction } from '@bike4mind/database';
import { creditService } from '@bike4mind/services';
import type { ImageCreditHolds } from '@bike4mind/services/llm/ImageGeneration';
import { CREDIT_HOLD_TTL_MS, holdAdapters, releaseHeldCredits, settleHeldCredits } from './reserveRequestCredits';
import { claimPaidCallRunBudget } from './runBudgetClaim';

/**
 * The image generation / edit queue workers' credit holds. Each hold is recorded as a PendingCreditHold
 * row in the same transaction as the balance move, so a worker that dies mid-render leaves a hold the
 * expired-hold sweep (apps/workers/src/cron/creditHoldSweep.ts) refunds; settle and release claim that
 * row, so exactly one of settle, release and the sweep moves balance.
 *
 * A `run` claims the whole hold from the run's budget in the same transaction and records the claim
 * on the pending row; whichever of settle, release and the sweep claims the row returns it to the run.
 */
export const imageCreditHolds: ImageCreditHolds = {
  hold: ({ userId, organizationId, requiredCredits, featureLabel, logger, run }) =>
    withTransaction(async () => {
      // First, so a refused claim moves no balance; rolled back with the hold if anything below fails.
      const runClaim = run ? await claimPaidCallRunBudget(run.runId, requiredCredits) : undefined;
      const hold = await creditService.holdCredits(
        { userId, organizationId, requiredCredits, featureLabel, logger },
        holdAdapters
      );
      const pending = await pendingCreditHoldRepository.record(
        hold,
        featureLabel,
        new Date(Date.now() + CREDIT_HOLD_TTL_MS),
        runClaim
      );
      return { ...hold, pendingHoldId: pending.id, ...(pending.runClaim && { runClaim: pending.runClaim }) };
    }),

  release: releaseHeldCredits,

  settle: (hold, chargedCredits, entry, context) => settleHeldCredits(hold, chargedCredits, entry, context),
};
