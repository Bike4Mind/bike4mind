/**
 * The cost consequence of replacing one model with another, as the approving
 * admin reads it.
 *
 * A successor mapping that raises a bill needs platform-admin approval rather
 * than automation, and an approval is only meaningful with the number in front
 * of the operator: mapping grok-3-mini to grok-4.5 would have been 6.7x input
 * and 12x output, which is the shape this exists to stop.
 */

/** A model's comparable rate as the admin surfaces show it: USD per million tokens. */
export interface PerMTokRate {
  input: number;
  output: number;
}

/** Price rows store USD per token; every operator surface reads per MTok. */
const TOKENS_PER_MTOK = 1_000_000;

export const toPerMTokRate = (perToken: { input: number; output: number }): PerMTokRate => ({
  input: perToken.input * TOKENS_PER_MTOK,
  output: perToken.output * TOKENS_PER_MTOK,
});

export type SuccessorCostVerdict = 'cheaper-or-equal' | 'more-expensive' | 'unverifiable';

export interface RateChange {
  from: number;
  to: number;
  /** Absent when `from` is 0 and `to` is not: that increase has no finite ratio. */
  pctChange?: number;
}

export interface SuccessorCostDelta {
  verdict: SuccessorCostVerdict;
  /** Both absent on an 'unverifiable' verdict - there is nothing to compare. */
  input?: RateChange;
  output?: RateChange;
}

const rateChange = (from: number, to: number): RateChange => {
  if (from === to) return { from, to, pctChange: 0 };
  if (from === 0) return { from, to };
  return { from, to, pctChange: ((to - from) / from) * 100 };
};

/**
 * Must stay in sync with the cost clause in the discovery service's
 * `verifyReplacement` (lifecyclePlan.ts): the two read the same rates in force,
 * and a verdict here that disagreed with the clause there would show an admin a
 * green delta on a successor the automation had already refused as
 * 'cost-not-lower'. A rate missing on either side is unverifiable, not free.
 */
export function successorCostDelta(
  modelId: string,
  successorId: string,
  rates: Readonly<Record<string, PerMTokRate>>
): SuccessorCostDelta {
  const current = rates[modelId];
  const successor = rates[successorId];
  if (!current || !successor) return { verdict: 'unverifiable' };

  return {
    verdict:
      successor.input <= current.input && successor.output <= current.output ? 'cheaper-or-equal' : 'more-expensive',
    input: rateChange(current.input, successor.input),
    output: rateChange(current.output, successor.output),
  };
}

/** Rates span roughly $0.02 to $75 per MTok, so a single fixed precision is wrong at one end. */
export function formatPerMTok(rate: number): string {
  if (rate === 0) return '$0';
  return `$${rate.toFixed(rate < 1 ? 3 : 2)}`;
}

/**
 * Large increases carry the multiple alongside the percentage: '+570%' and
 * '6.7x' land differently, and the multiple is the form the cost-safety
 * decision was argued in.
 */
export function formatPctChange(pctChange: number | undefined): string {
  if (pctChange === undefined) return 'from $0';
  if (pctChange === 0) return 'no change';
  const sign = pctChange > 0 ? '+' : '';
  const pct = `${sign}${pctChange.toFixed(Math.abs(pctChange) < 10 ? 1 : 0)}%`;
  return pctChange >= 100 ? `${pct} (${(1 + pctChange / 100).toFixed(1)}x)` : pct;
}
