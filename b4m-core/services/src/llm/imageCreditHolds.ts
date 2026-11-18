import type { CompletionRunAttribution, PersistedCreditHold } from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';
import type { CreditLedgerEntry } from '../creditService/creditHold';

type HoldContext = { featureLabel: string; logger: Logger };

/**
 * The credit reservation port for the image generation and image edit queue workers. The app
 * implements it over creditService's holdCredits / settleCreditHold / releaseCreditHold plus a
 * PendingCreditHold row, so a worker that dies mid-render leaves a hold the expired-hold sweep refunds.
 */
export type ImageCreditHolds = {
  /**
   * Atomically move `requiredCredits` out of the payer's balance BEFORE the provider is called.
   * Checks the org member cap before the atomic balance move; the cap check is not atomic.
   * Throws a 422 `insufficient_credits` when the balance or the org member cap cannot cover it.
   * With a `run` (owner already checked), the whole hold is claimed from the run's budget in the same
   * transaction, or the hold is refused with a 422 `run_budget_exhausted` and nothing moves.
   */
  hold(
    params: HoldContext & {
      userId: string;
      organizationId: string | null;
      requiredCredits: number;
      run?: CompletionRunAttribution;
    }
  ): Promise<PersistedCreditHold>;
  /** Return the whole hold (and any run claim): the generation failed or stopped before producing a billable image. */
  release(hold: PersistedCreditHold, context: HoldContext): Promise<void>;
  /**
   * Keep `chargedCredits` (clamped to the hold), refund the rest and write the ledger row. A run claim
   * is released down to the charge; the caller tags `entry.run` so the run's usage read counts it.
   * Returns the confirmed charge, or 0 if already swept or settlement cannot be confirmed.
   */
  settle(
    hold: PersistedCreditHold,
    chargedCredits: number,
    entry: CreditLedgerEntry,
    context: HoldContext
  ): Promise<number>;
};
