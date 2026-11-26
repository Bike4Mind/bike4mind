export type BackoffPolicy = {
  /** The first retry's delay before jitter, in ms. */
  baseMs: number;
  /** The longest delay before jitter, in ms. */
  capMs: number;
};

export const DEFAULT_BACKOFF: BackoffPolicy = { baseMs: 1_000, capMs: 60_000 };

/**
 * The wait before retry `attempt` (1-based): doubling from `baseMs` up to `capMs`, then scaled
 * into its upper half by `random` so hosts that dropped together do not all retry together.
 */
export function backoffDelay(attempt: number, policy: BackoffPolicy, random: () => number): number {
  const exponent = Math.max(0, attempt - 1);
  const ceiling = Math.min(policy.capMs, policy.baseMs * 2 ** Math.min(exponent, 30));
  return Math.round(ceiling / 2 + (ceiling / 2) * random());
}
