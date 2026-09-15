import { z } from 'zod';

/**
 * Evidence tier classifies how strong the support is for a claim or finding.
 *
 * Lifted directly from the patterns evolved in a prior long-horizon
 * paper-reproduction agent, where the claims ledger distinguished
 * "engineering evidence" from "paper-facing evidence".
 *
 * This is the most important schema-level invariant inherited from the
 * working paper-reproduction agent: every long-horizon agent must be able
 * to distinguish *"I made this work in my sandbox"* from *"this passes the
 * external bar"*. Drives and budgets behave differently at each tier:
 * exploration is cheap at low tiers and expensive at high tiers.
 *
 * - `engineering-proxy`: works on a small/synthetic proxy of the real
 *   problem. Cheapest to produce, weakest claim.
 * - `engineering-scaled`: works at production-relevant scale, but still
 *   inside the agent's own sandbox. No external validation.
 * - `external-facing`: passes an externally-defined bar (target metric,
 *   reference dataset, paper claim). Still agent-graded.
 * - `human-reviewed`: an external human reviewer has signed off. Highest
 *   tier; required before any public artifact ships.
 */
export const EvidenceTierSchema = z.enum([
  'engineering-proxy',
  'engineering-scaled',
  'external-facing',
  'human-reviewed',
]);

export type EvidenceTier = 'engineering-proxy' | 'engineering-scaled' | 'external-facing' | 'human-reviewed';

/**
 * Ordered for monotonic comparisons ("is this tier at least X?").
 */
export const EVIDENCE_TIER_ORDER: readonly EvidenceTier[] = [
  'engineering-proxy',
  'engineering-scaled',
  'external-facing',
  'human-reviewed',
] as const;

export function evidenceTierRank(tier: EvidenceTier): number {
  return EVIDENCE_TIER_ORDER.indexOf(tier);
}

export function evidenceTierAtLeast(actual: EvidenceTier, required: EvidenceTier): boolean {
  return evidenceTierRank(actual) >= evidenceTierRank(required);
}
