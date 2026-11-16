import { CreditHolderType, RUN_BUDGET_EXHAUSTED_ERROR_CODE, UnprocessableEntityError } from '@bike4mind/common';
import {
  completionRunRepository,
  pendingCreditHoldRepository,
  userRepository,
  withTransaction,
  type PendingCreditHold,
} from '@bike4mind/database';
import { newAccountSpendCapAdaptersWithAlert } from '@bike4mind/server-utils/billing/newAccountSpendCapWithAlert';
import { creditService } from '@bike4mind/services';
import type { CompletionCreditHolds } from '@bike4mind/services/cliCompletions';
import type { Logger } from '@bike4mind/observability';
import { observeCreditHold, recordSettlementAfterSweep } from '@bike4mind/server-utils/billing/creditHoldTelemetry';

// Completion holds become eligible for recovery after one hour, including requests still running.
export const COMPLETION_CREDIT_HOLD_TTL_MS = 60 * 60_000;
const SETTLEMENT_ATTEMPTS = 3;

/** The deterministic refusal a client shows when a run has no headroom left; no model call writes it. */
export function runBudgetExhaustedMessage(budgetCredits: number, committedCredits: number): string {
  return (
    `This run's credit budget is used up: ${committedCredits} of its ${budgetCredits} credits are spent or ` +
    'reserved by requests still running. Retry once those requests finish, or raise the run budget.'
  );
}

/**
 * One instance per completion; inference always runs outside the billing transactions. A completion
 * attributed to a budgeted run claims its run budget in the same transaction as its balance hold, and
 * every terminal outcome of the hold (settle, refund, expired-hold sweep) releases that claim with it.
 */
export function createCompletionCreditHolds(logger: Logger): CompletionCreditHolds {
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
            const claimed = runClaim && (await claimRunBudget(runClaim));
            const holder = await debit();
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
      for (let attempt = 1; attempt <= SETTLEMENT_ATTEMPTS; attempt++) {
        try {
          const settled = await withTransaction(async () => {
            if (!(await pendingCreditHoldRepository.markSettled(holdId, chargedCredits))) {
              return (await pendingCreditHoldRepository.findSettlement(holdId)) !== null;
            }
            const recordedCredits = await settle();
            if (pending?.runClaim) await completionRunRepository.releaseClaim(pending.runClaim, recordedCredits);
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
  };
}

async function claimRunBudget(claim: { runId: string; wantedCredits: number; minimumCredits: number }) {
  const outcome = await completionRunRepository.claimBudget(claim.runId, claim.wantedCredits, claim.minimumCredits);
  if (outcome.kind === 'exhausted') {
    throw new UnprocessableEntityError(runBudgetExhaustedMessage(outcome.budgetCredits, outcome.committedCredits), {
      errorCode: RUN_BUDGET_EXHAUSTED_ERROR_CODE,
    });
  }
  return outcome.kind === 'claimed' ? outcome.credits : undefined;
}
