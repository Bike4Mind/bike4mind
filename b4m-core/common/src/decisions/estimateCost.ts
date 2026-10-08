import type { DecisionModelCapabilities } from './types';

const TOKENS_PER_MILLION = 1_000_000;

export type DecisionTokenUsage = { inputTokens: number; outputTokens: number };

/** Exact USD cost of a call from the provider-reported usage. Settled with `usdToCreditsStochastic`, never rounded up. */
export const decisionCostUsd = (caps: DecisionModelCapabilities, usage: DecisionTokenUsage): number =>
  (usage.inputTokens * caps.pricing.usdPerMillionInputTokens +
    usage.outputTokens * caps.pricing.usdPerMillionOutputTokens) /
  TOKENS_PER_MILLION;

/**
 * Upper bound on a call's cost, sized for the pre-flight credit hold: the model's whole input window. Output tokens are
 * bounded by the answer shape and priced at the same window, which is generous for every listed model.
 */
export const maxDecisionCostUsd = (caps: DecisionModelCapabilities): number =>
  decisionCostUsd(caps, { inputTokens: caps.limits.maxInputTokens, outputTokens: caps.limits.maxInputTokens });
