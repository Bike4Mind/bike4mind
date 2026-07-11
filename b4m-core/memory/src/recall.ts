/**
 * Recall (pull) - the read-time counterpart to the fold's push profile.
 *
 * The fold hands back a principal's whole belief set; recall answers "which of these are worth
 * surfacing for THIS query". It scores each belief by an ACT-R retrieval score: the belief's
 * base-level `activation` (recency + frequency, already computed by the fold) PLUS an associative
 * match term (how relevant the query is to the belief). That mirrors ACT-R's retrieval equation
 * (base-level activation + spreading activation), so a belief is recalled when it is both
 * top-of-mind AND on-topic - and with an empty query it degrades to "most top-of-mind", the profile.
 *
 * The relevance scorer is injectable so the host can supply embedding similarity; the core ships a
 * pure, zero-dependency lexical default so recall works with no external services.
 */

import { tokenize } from './text';
import type { Belief } from './types';

/** Relevance of a belief to a query, ideally in 0..1. Injected by the host for embedding recall. */
export type RecallScorer = (query: string, belief: Belief) => number;

/**
 * Default scorer: normalized token overlap (Jaccard) between the query and the belief's fact. Pure
 * and dependency-free; good enough to prove recall and to run with no embedding service. Returns
 * 0..1.
 */
export const lexicalScorer: RecallScorer = (query, belief) => {
  const q = new Set(tokenize(query));
  const f = new Set(tokenize(belief.fact));
  if (q.size === 0 || f.size === 0) return 0;
  let intersection = 0;
  for (const t of q) if (f.has(t)) intersection += 1;
  const union = q.size + f.size - intersection;
  return union === 0 ? 0 : intersection / union;
};

export interface RecallOptions {
  /** Relevance scorer; defaults to the pure lexical overlap. Supply embedding similarity at the host. */
  scorer?: RecallScorer;
  /** Maximum results to return. */
  k?: number;
  /** Weight blending relevance into the ACT-R activation score. Raise it to let topicality dominate. */
  relevanceWeight?: number;
  /**
   * Topicality floor: drop beliefs whose relevance is below this. Default 0 keeps everything (so an
   * empty query still returns the most-active beliefs). Set it above 0 to require an on-topic match
   * and keep a merely-hot-but-off-topic belief out of the results.
   */
  minRelevance?: number;
}

export interface RecalledBelief {
  belief: Belief;
  /** The scorer's relevance for this query, 0..1 for the lexical default. */
  relevance: number;
  /** activation + relevanceWeight * relevance - the ACT-R retrieval score this ranks by. */
  score: number;
}

const DEFAULT_K = 8;
const DEFAULT_RELEVANCE_WEIGHT = 1;

/**
 * Rank a principal's beliefs for a query by ACT-R retrieval score (activation + associative match),
 * returning the top `k`. An empty query scores every belief 0 on relevance, so results fall back to
 * pure activation order - i.e. the most top-of-mind beliefs.
 */
export function recall(beliefs: readonly Belief[], query: string, options: RecallOptions = {}): RecalledBelief[] {
  const scorer = options.scorer ?? lexicalScorer;
  const relevanceWeight = options.relevanceWeight ?? DEFAULT_RELEVANCE_WEIGHT;
  const k = options.k ?? DEFAULT_K;
  const minRelevance = options.minRelevance ?? 0;

  return beliefs
    .map((belief): RecalledBelief => {
      const relevance = scorer(query, belief);
      return { belief, relevance, score: (belief.activation ?? 0) + relevanceWeight * relevance };
    })
    .filter(r => r.relevance >= minRelevance)
    .sort((a, b) => b.score - a.score || b.relevance - a.relevance || a.belief.id.localeCompare(b.belief.id))
    .slice(0, k);
}
