import { spendCapExceededError } from '@bike4mind/common';

/** The minimal per-key fields the spend-cap gate reads. */
export interface KeySpendState {
  /** Spend ceiling in credits. `undefined` = no cap; a present 0 is a real cap. */
  spendCap?: number;
  /** Cumulative settled spend in credits (`usage.totalSpendCredits`); absent = 0. */
  currentSpend?: number;
  /** Optional key name for the error message. */
  keyName?: string;
}

/**
 * Pre-flight spend-cap gate for the embed completion path, sibling to
 * assertOwnerHasCredits: pure and settings-free (never reads `enforceCredits`),
 * so a capped key is refused regardless of the platform-wide toggle.
 *
 * Throws a 422 `spend_cap_exceeded` when the key's accumulated spend has reached
 * its cap. `spendCap !== undefined` is the load-bearing guard: a cap of 0 must
 * block all spend, not read as "uncapped". The check is a backstop, not exact -
 * concurrent in-flight streams can each pass under the cap and settle past it,
 * bounded by the per-key rate limit.
 */
export function assertKeySpendWithinCap(state: KeySpendState): void {
  if (state.spendCap === undefined) return;
  const spent = state.currentSpend ?? 0;
  if (spent >= state.spendCap) {
    throw spendCapExceededError(
      state.keyName ? `${state.keyName} has reached its spend cap` : 'This embed key has reached its spend cap'
    );
  }
}
