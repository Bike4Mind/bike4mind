import type { PersistedCreditHold } from '@bike4mind/common';
import { pendingCreditHoldRepository, withTransaction, type PendingCreditHold } from '@bike4mind/database';
import { creditService } from '@bike4mind/services';
import type { ImageCreditHolds } from '@bike4mind/services/llm/ImageGeneration';
import { CREDIT_HOLD_TTL_MS, holdAdapters, releaseHeldCredits, settleHeldCredits } from './reserveRequestCredits';
import { isDuplicateKeyError } from '../utils/isDuplicateKeyError';
import { claimPaidCallRunBudget } from './runBudgetClaim';

const reuse = (pending: PendingCreditHold): PersistedCreditHold & { reused: true } => ({
  ownerId: pending.ownerId,
  ownerType: pending.ownerType,
  userId: pending.userId,
  organizationId: pending.organizationId,
  reservedCredits: pending.reservedCredits,
  balanceAfterHold: pending.balanceAfterHold,
  pendingHoldId: pending.id,
  ...(pending.runClaim && { runClaim: pending.runClaim }),
  reused: true,
});

const holdOnce: ImageCreditHolds['hold'] = ({
  userId,
  organizationId,
  requiredCredits,
  featureLabel,
  logger,
  apiKeyId,
  apiKeyBillingOwnerType,
  run,
  holdKey,
}) =>
  withTransaction(async () => {
    const outstanding = holdKey ? await pendingCreditHoldRepository.findOutstandingByKey(holdKey) : null;
    if (outstanding) return reuse(outstanding);
    // First, so a refused claim moves no balance; rolled back with the hold if anything below fails.
    const runClaim = run ? await claimPaidCallRunBudget(run.runId, requiredCredits) : undefined;
    const hold = await creditService.holdCredits(
      { userId, organizationId, requiredCredits, featureLabel, logger, apiKeyId, apiKeyBillingOwnerType },
      holdAdapters
    );
    const pending = await pendingCreditHoldRepository.record(
      hold,
      featureLabel,
      new Date(Date.now() + CREDIT_HOLD_TTL_MS),
      runClaim,
      holdKey
    );
    return { ...hold, pendingHoldId: pending.id, ...(pending.runClaim && { runClaim: pending.runClaim }) };
  });

/**
 * The image generation / edit queue workers' credit holds. Each hold is recorded as a PendingCreditHold
 * row in the same transaction as the balance move, so a worker that dies mid-render leaves a hold the
 * expired-hold sweep (apps/workers/src/cron/creditHoldSweep.ts) refunds; settle and release claim that
 * row, so exactly one of settle, release and the sweep moves balance.
 *
 * A `run` claims the whole hold from the run's budget in the same transaction and records the claim
 * on the pending row; whichever of settle, release and the sweep claims the row returns it to the run.
 *
 * A `holdKey` (the generation id) makes the hold idempotent across queue redeliveries: an outstanding
 * row under that key is handed back instead of holding and claiming again. Two racing deliveries
 * collide on the row's unique key, and the loser's transaction rolls back before it reads the winner's.
 */
export const imageCreditHolds: ImageCreditHolds = {
  hold: async params => {
    const { holdKey } = params;
    try {
      return await holdOnce(params);
    } catch (error) {
      if (!holdKey || !isDuplicateKeyError(error)) throw error;
      const winner = await pendingCreditHoldRepository.findOutstandingByKey(holdKey);
      if (!winner) throw error;
      return reuse(winner);
    }
  },

  release: releaseHeldCredits,

  settle: (hold, chargedCredits, entry, context) => settleHeldCredits(hold, chargedCredits, entry, context),
};
