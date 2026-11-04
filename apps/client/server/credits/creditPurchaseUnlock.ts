import { unlockSignupGrantFromPayment } from './subscriptionUnlock';

/**
 * Releases the whole remaining signup grant once the user has bought a credit pack, held for
 * `signupUnlockPaymentHoldHours` like any payment unlock. A redelivery finishes a release a crashed
 * delivery left undone and is otherwise a no-op: the remainder is gone and the ledger id is unique.
 */
export const unlockSignupGrantFromCreditPurchase = (
  userId: string,
  logger?: { warn: (message: string, meta?: Record<string, unknown>) => void }
) => unlockSignupGrantFromPayment(userId, 'credit_purchase', 'Bought a credit pack', logger);
