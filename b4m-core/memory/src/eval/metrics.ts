/**
 * Retrieval metrics for the memory eval.
 *
 * Pure and dependency-free: they take an ORDERED list of belief ids (what a retrieval policy would
 * inject, best first) plus the ids that are actually relevant, and score the ordering. Nothing here
 * knows about embeddings, ACT-R, or the DB - which is what lets the same numbers judge V1 and V2 on
 * identical footing.
 */

/**
 * Did the policy surface a relevant belief at all within the top k?
 *
 * This is the question that matters most for a chat prompt: a belief the model never sees cannot
 * help it, no matter how well it was scored. 1 when at least one relevant id is in the top k.
 */
export function hitRateAtK(ranked: readonly string[], relevant: ReadonlySet<string>, k: number): number {
  return ranked.slice(0, k).some(id => relevant.has(id)) ? 1 : 0;
}

/** Fraction of the relevant beliefs that made it into the top k. */
export function recallAtK(ranked: readonly string[], relevant: ReadonlySet<string>, k: number): number {
  if (relevant.size === 0) return 1; // nothing to find: vacuously perfect
  const found = ranked.slice(0, k).filter(id => relevant.has(id)).length;
  return found / relevant.size;
}

/**
 * Fraction of what the policy INJECTED that was actually relevant. The counterweight to recall: a
 * policy that dumps every belief every time scores a perfect recall and a terrible precision, and it
 * is precision that governs how much irrelevant memory the model is invited to confabulate from.
 */
export function precisionAtK(ranked: readonly string[], relevant: ReadonlySet<string>, k: number): number {
  const top = ranked.slice(0, k);
  if (top.length === 0) return 1; // injected nothing: nothing irrelevant was injected
  return top.filter(id => relevant.has(id)).length / top.length;
}

/** Reciprocal rank of the FIRST relevant belief (1 = top of the list, 0 = absent). Rewards ordering. */
export function reciprocalRank(ranked: readonly string[], relevant: ReadonlySet<string>): number {
  const i = ranked.findIndex(id => relevant.has(id));
  return i === -1 ? 0 : 1 / (i + 1);
}

export interface QueryOutcome {
  hit: number;
  recall: number;
  precision: number;
  rr: number;
  /** How many beliefs the policy chose to inject for this query. */
  injected: number;
}

/** Score one query's ranked output against its relevant set. */
export function scoreQuery(ranked: readonly string[], relevant: ReadonlySet<string>, k: number): QueryOutcome {
  return {
    hit: hitRateAtK(ranked, relevant, k),
    recall: recallAtK(ranked, relevant, k),
    precision: precisionAtK(ranked, relevant, k),
    rr: reciprocalRank(ranked, relevant),
    injected: Math.min(ranked.length, k),
  };
}

export interface Aggregate {
  n: number;
  hitRate: number;
  recall: number;
  precision: number;
  mrr: number;
  meanInjected: number;
}

const mean = (xs: number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);

/** Mean each metric across queries. `mrr` is the mean reciprocal rank. */
export function aggregate(outcomes: readonly QueryOutcome[]): Aggregate {
  return {
    n: outcomes.length,
    hitRate: mean(outcomes.map(o => o.hit)),
    recall: mean(outcomes.map(o => o.recall)),
    precision: mean(outcomes.map(o => o.precision)),
    mrr: mean(outcomes.map(o => o.rr)),
    meanInjected: mean(outcomes.map(o => o.injected)),
  };
}

/**
 * The negative case, scored on its own terms: for a query whose answer is NOT in memory, the only
 * thing that matters is how much memory the policy injected anyway. Every belief it hands over is a
 * distractor the model may confabulate from ("you asked about a dog; I know you keep clownfish...").
 *
 * `falseInjectionRate` is the share of negative queries that got ANY memory at all; `meanInjected`
 * is how much, on average. A policy with a topicality floor should score near zero on both; a
 * top-k-regardless policy scores 1.0 and k by construction.
 */
export function scoreNegatives(injectedCounts: readonly number[]): {
  n: number;
  falseInjectionRate: number;
  meanInjected: number;
} {
  return {
    n: injectedCounts.length,
    falseInjectionRate: mean(injectedCounts.map(c => (c > 0 ? 1 : 0))),
    meanInjected: mean([...injectedCounts]),
  };
}
