import { CreditHolderType } from '@bike4mind/common';
import {
  completionRunRepository,
  pendingCreditHoldRepository,
  userRepository,
  warmExchangeAttribution,
  withTransaction,
  type PendingCreditHold,
} from '@bike4mind/database';
import { newAccountSpendCapAdaptersWithAlert } from '@bike4mind/server-utils/billing/newAccountSpendCapWithAlert';
import { creditService } from '@bike4mind/services';
import type { CompletionCreditHolds } from '@bike4mind/services/cliCompletions';
import type { Logger } from '@bike4mind/observability';
import { observeCreditHold, recordSettlementAfterSweep } from '@bike4mind/server-utils/billing/creditHoldTelemetry';
import { claimRunBudget } from '@bike4mind/server-utils/billing/runBudgetClaim';

// Completion holds become eligible for recovery after one hour, including requests still running.
export const COMPLETION_CREDIT_HOLD_TTL_MS = 60 * 60_000;
const SETTLEMENT_ATTEMPTS = 3;
/**
 * The most of a run's headroom past its minimum that one completion claim may take. A completion's
 * claim is sized to its full output budget but it can be cut short to fit, so capping it leaves the run's concurrent
 * workers room to start; the round gate shrinks the round's output to the claim it got.
 */
export const COMPLETION_CLAIM_SHARE_OF_REMAINING = 0.5;

/**
 * One instance per completion; inference always runs outside the billing transactions. A completion
 * attributed to a budgeted run claims its run budget in the same transaction as its balance hold, tops
 * that claim up before each tool round, and every terminal outcome of the hold (settle, refund,
 * expired-hold sweep) releases that claim with it.
 */
export function createCompletionCreditHolds(logger: Logger, apiKeyId?: string): CompletionCreditHolds {
  let pending: PendingCreditHold | undefined;

  return {
    async reserve(hold, debit, runClaim) {
      if (hold.ownerType === CreditHolderType.User) {
        const user = await userRepository.findById(hold.userId);
        if (user) {
          await creditService.assertNewAccountSpendWithinCap(
            { user, requestedCredits: hold.reservedCredits, billedToOrganization: false, logger },
            newAccountSpendCapAdaptersWithAlert
          );
        }
      }
      pending = await observeCreditHold(
        { ...hold, featureLabel: 'platform-key completion', lifecycle: 'completion' },
        () =>
          withTransaction(async () => {
            const claimed =
              runClaim &&
              (await claimRunBudget({
                ...runClaim,
                neededCredits: runClaim.minimumCredits,
                maxShareOfRemaining: COMPLETION_CLAIM_SHARE_OF_REMAINING,
              }));
            const holder = await debit();
            // Inside the transaction, so a refusal aborts the debit with it.
            await creditService.assertInterventionSpendAllowed(
              { userId: hold.userId, credits: hold.reservedCredits },
              { users: userRepository, window: newAccountSpendCapAdaptersWithAlert.interventionSpendWindow }
            );
            return pendingCreditHoldRepository.record(
              { ...hold, balanceAfterHold: holder.currentCredits },
              'platform-key completion',
              new Date(Date.now() + COMPLETION_CREDIT_HOLD_TTL_MS),
              claimed ? { runId: runClaim.runId, credits: claimed } : undefined
            );
          })
      );
      return pending.runClaim?.credits;
    },
    async refund(refund) {
      if (!pending) return false;
      const holdId = pending.id;
      try {
        return await withTransaction(async () => {
          const claimed = await pendingCreditHoldRepository.claim(holdId);
          if (!claimed) return false;
          await refund();
          if (claimed.runClaim) await completionRunRepository.releaseClaim(claimed.runClaim, 0);
          return true;
        });
      } catch (error) {
        logger.error('Completion credit refund failed - left for the expired-hold sweep', { holdId, error });
        return false;
      }
    },
    async settle(chargedCredits, settle) {
      if (!pending) return false;
      const holdId = pending.id;
      await warmExchangeAttribution(apiKeyId);
      for (let attempt = 1; attempt <= SETTLEMENT_ATTEMPTS; attempt++) {
        try {
          const settled = await withTransaction(async () => {
            const settledHold = await pendingCreditHoldRepository.markSettledAndRead(holdId, chargedCredits);
            if (!settledHold) {
              return (await pendingCreditHoldRepository.findSettlement(holdId)) !== null;
            }
            const recordedCredits = await settle({ runClaimCredits: settledHold.runClaim?.credits });
            // The stored claim, not `pending`: a top-up can commit even when its acknowledgement was lost.
            if (settledHold.runClaim) await completionRunRepository.releaseClaim(settledHold.runClaim, recordedCredits);
            return true;
          });
          if (!settled) {
            logger.error('Completion credit hold was already refunded by the sweep', { holdId });
            recordSettlementAfterSweep(
              { ...pending, featureLabel: 'platform-key completion', lifecycle: 'completion' },
              holdId
            );
          }
          return settled;
        } catch (error) {
          // A lost commit acknowledgement must not apply the balance delta or ledger twice.
          try {
            if ((await pendingCreditHoldRepository.findSettlement(holdId)) !== null) return true;
          } catch (receiptError) {
            logger.error('Completion settlement receipt lookup failed', { holdId, error: receiptError });
          }
          if (attempt === SETTLEMENT_ATTEMPTS) {
            logger.error('Completion credit settlement failed - left for the expired-hold sweep', { holdId, error });
          }
        }
      }
      return false;
    },
    async topUpRunClaim(claim) {
      const runClaim = pending?.runClaim;
      if (!pending || !runClaim) return 0;
      const holdId = pending.id;
      try {
        const added = await withTransaction(async () => {
          const outcome = await completionRunRepository.claimBudget(
            runClaim.runId,
            claim.wantedCredits,
            claim.minimumCredits,
            COMPLETION_CLAIM_SHARE_OF_REMAINING
          );
          if (outcome.kind !== 'claimed') return 0;
          // A hold already settled, refunded or swept has released its claim, so a top-up must not outlive it.
          if (!(await pendingCreditHoldRepository.addRunClaimCredits(holdId, outcome.credits))) {
            await completionRunRepository.releaseClaim({ runId: runClaim.runId, credits: outcome.credits }, 0);
            return 0;
          }
          return outcome.credits;
        });
        pending = { ...pending, runClaim: { ...runClaim, credits: runClaim.credits + added } };
        return added;
      } catch (error) {
        logger.error('Completion run claim top-up failed', { holdId, error });
        return 0;
      }
    },
  };
}
