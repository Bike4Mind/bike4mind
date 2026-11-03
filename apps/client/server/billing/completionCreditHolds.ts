import { CreditHolderType } from '@bike4mind/common';
import {
  newAccountSpendCapAdapters,
  pendingCreditHoldRepository,
  userRepository,
  withTransaction,
  type PendingCreditHold,
} from '@bike4mind/database';
import { creditService } from '@bike4mind/services';
import type { CompletionCreditHolds } from '@bike4mind/services/cliCompletions';
import type { Logger } from '@bike4mind/observability';

// Completion holds become eligible for recovery after one hour, including requests still running.
export const COMPLETION_CREDIT_HOLD_TTL_MS = 60 * 60_000;
const SETTLEMENT_ATTEMPTS = 3;

/** One instance per completion; inference always runs outside the billing transactions. */
export function createCompletionCreditHolds(logger: Logger): CompletionCreditHolds {
  let pending: PendingCreditHold | undefined;

  return {
    async reserve(hold, debit) {
      if (hold.ownerType === CreditHolderType.User) {
        const user = await userRepository.findById(hold.userId);
        if (user) {
          await creditService.assertNewAccountSpendWithinCap(
            { user, requestedCredits: hold.reservedCredits, billedToOrganization: false, logger },
            newAccountSpendCapAdapters
          );
        }
      }
      pending = await withTransaction(async () => {
        const holder = await debit();
        return pendingCreditHoldRepository.record(
          { ...hold, balanceAfterHold: holder.currentCredits },
          'platform-key completion',
          new Date(Date.now() + COMPLETION_CREDIT_HOLD_TTL_MS)
        );
      });
    },
    async refund(refund) {
      if (!pending) return false;
      const holdId = pending.id;
      try {
        return await withTransaction(async () => {
          if (!(await pendingCreditHoldRepository.claim(holdId))) return false;
          await refund();
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
          return await withTransaction(async () => {
            if (!(await pendingCreditHoldRepository.markSettled(holdId, chargedCredits))) {
              const settled = (await pendingCreditHoldRepository.findSettlement(holdId)) !== null;
              if (!settled) logger.error('Completion credit hold was already refunded by the sweep', { holdId });
              return settled;
            }
            await settle();
            return true;
          });
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
