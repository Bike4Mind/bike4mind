/** Cadence bound for switch/rate notices, which have no natural period of their own - at most one per lake per hour. */
export const SPEND_NOTIFY_WINDOW_MS = 3_600_000;

/**
 * The platform-period meter's own fixed-window `expiresAt` is constant for the life of the
 * window and changes the instant it rolls - a free, exact periodKey with no clock arithmetic.
 */
export const periodKeyForWindow = (expiresAt: Date): string => `w:${expiresAt.toISOString()}`;

/** One notice per upload batch (the per-run budget is scoped to a single batch). */
export const periodKeyForRun = (batchId: string): string => `run:${batchId}`;

/**
 * The per-lake meter is a LIFETIME counter with no period, so it is keyed on the CONFIGURED
 * BUDGET VALUE itself: raising `dataLakeEmbeddingBudgetPerLakeUsd` changes the key, so the old
 * claim no longer matches and the notice re-arms - exactly the behavior an operator expects
 * after granting more budget.
 */
export const periodKeyForLakeBudget = (budgetMicroUsd: number): string => `lake:${budgetMicroUsd}`;

/** Hour-bucketed clock for switch/rate, which have no natural period - a spam bound only. */
export const periodKeyForClock = (now: Date): string => `t:${Math.floor(now.getTime() / SPEND_NOTIFY_WINDOW_MS)}`;
