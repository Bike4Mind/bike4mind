/**
 * Principal-scoped memory core.
 *
 * The DRY seam of Mementos 2.0: memory belongs to a PRINCIPAL (whose memory / which scope),
 * independent of the ACTOR that authored any given event. A principal is a user, an agent, an
 * org, or the system - all fold from one substrate. These shapes generalize what the DeepAgent
 * Charter/Episode model already ships for agents; user mementos plug in behind the same types.
 */

export type PrincipalKind = 'user' | 'agent' | 'org' | 'system';

export interface Principal {
  kind: PrincipalKind;
  id: string;
}

/**
 * Confidence ladder for a belief, low -> high. Mirrors DeepAgent's EvidenceTier so an agent's
 * evidence-graded semantic memory maps across without loss.
 */
export type EvidenceTier = 'engineering-proxy' | 'engineering-scaled' | 'external-facing' | 'human-reviewed';

export const EVIDENCE_TIERS: readonly EvidenceTier[] = [
  'engineering-proxy',
  'engineering-scaled',
  'external-facing',
  'human-reviewed',
];

/**
 * A semantic belief: a fact carrying its provenance and an evidence tier. Generalizes a
 * DeepAgent Charter.semanticMemory entry. `derivedFrom` are the ledger event ids this belief was
 * folded from - memory with citations.
 */
export interface Belief {
  id: string;
  fact: string;
  evidenceTier: EvidenceTier;
  /** 0..1 */
  confidence: number;
  /**
   * Salience/heat tier, a distinct axis from `evidenceTier` (confidence-in-the-claim): how
   * top-of-mind the memory is. When beliefs are folded from a ledger this is COMPUTED from
   * `activation` (ACT-R), so it decays as a belief goes untouched; adapters that project a snapshot
   * (user mementos) carry it through from their source tier instead.
   */
  salience?: 'hot' | 'warm' | 'cold';
  /**
   * ACT-R base-level activation: `ln(sum of dt^-d)` over the belief's presentations (its assert +
   * affirms in the ledger), evaluated as of a given time. Higher = more active/top-of-mind. Present
   * only on ledger-folded beliefs; `salience` is its thresholded tier.
   */
  activation?: number;
  derivedFrom: string[];
  /** ISO-8601. */
  lastAffirmedAt: string;
}

/**
 * The principal's push profile: identity plus the working belief set, read at session/wake start.
 * Generalizes a DeepAgent Charter. `sizeBudgetBytes` is the scarcity budget that triggers grooming.
 */
export interface MemoryProfile {
  principal: Principal;
  name?: string;
  role?: string;
  beliefs: Belief[];
  /** Scarcity budget that triggers grooming. Charter-specific; absent for sources with no byte budget. */
  sizeBudgetBytes?: number;
  /** Monotonic profile version, where the source tracks one. */
  version?: number;
  /** ISO-8601; set when the profile was last groomed. */
  groomedAt?: string;
}
