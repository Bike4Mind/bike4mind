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

/** Cosine similarity of two equal-length vectors, 0 when either is empty or zero-magnitude. */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

/**
 * Semantic scorer: cosine similarity between a PRE-COMPUTED query embedding and the belief's own
 * `embedding`. This is the retrieval-parity gate against V1 (which ranks mementos by vector
 * similarity) - lexical overlap cannot match "what hue do I like?" to "favorite color is green",
 * and embeddings can.
 *
 * The query is embedded once by the host (an API call) and passed in; per-belief scoring is pure.
 * A belief with no embedding falls back to `fallback` (lexical by default), so a mixed belief set -
 * some sources carry embeddings, some do not - still ranks sensibly instead of scoring 0.
 */
export function embeddingScorer(
  queryEmbedding: readonly number[],
  fallback: RecallScorer = lexicalScorer
): RecallScorer {
  return (query, belief) =>
    belief.embedding?.length && queryEmbedding.length
      ? cosineSimilarity(queryEmbedding, belief.embedding)
      : fallback(query, belief);
}

export interface RecallOptions {
  /** Relevance scorer; defaults to the pure lexical overlap. Supply embedding similarity at the host. */
  scorer?: RecallScorer;
  /** Maximum results to return. */
  k?: number;
  /**
   * How far a belief's ACT-R activation may move it RELATIVE to topicality. 0 = rank purely on
   * topic; 1 = heat counts as much as topic. Default 0.1: swept on the eval corpus, it is the
   * largest weight at which heat only reorders genuine near-ties - MRR holds at parity with plain
   * vector search up to 0.10 and degrades beyond it.
   *
   * Both axes are normalized to 0..1 across the candidate set before they are blended, because they
   * are otherwise on incompatible scales and a raw sum silently hands the ranking to whichever one
   * happens to have the wider spread. Activation is an UNBOUNDED log quantity (ln of a sum of decayed
   * presentations); relevance is a BOUNDED similarity, and a compressed embedding model squeezes it
   * into a narrow band. Measured on the eval corpus: activation spread 3.29 against a cosine spread
   * of 0.09 - so an unnormalized sum ranked purely by heat, buried the correct belief beneath
   * whatever was merely recent, and dropped hit rate to 69% where plain vector search got 100%.
   */
  activationWeight?: number;
  /**
   * Topicality floor, applied to the RAW relevance (not the normalized one - a floor has to mean the
   * same thing from query to query). Beliefs below it are not returned at all. Default 0 keeps
   * everything, so an empty query still degrades to "the most active beliefs" - the profile.
   *
   * Above 0 this is what keeps a merely-hot, off-topic belief out of the prompt, and with it the
   * invitation to confabulate from a memory that has nothing to do with the question.
   */
  minRelevance?: number;
}

export interface RecalledBelief {
  belief: Belief;
  /** The scorer's relevance for this query, 0..1 for the lexical default. */
  relevance: number;
  /** normalized relevance + activationWeight * normalized activation - what this ranks by. */
  score: number;
}

const DEFAULT_K = 8;
const DEFAULT_ACTIVATION_WEIGHT = 0.1;

/** Min-max to 0..1 over the candidate set. A degenerate spread (every value equal) maps to 0. */
const normalizer = (values: readonly number[]): ((v: number) => number) => {
  const min = Math.min(...values);
  const spread = Math.max(...values) - min;
  return spread > 1e-9 ? (v: number) => (v - min) / spread : () => 0;
};

/**
 * Rank a principal's beliefs for a query by ACT-R retrieval score - topicality (associative match)
 * led, activation (recency + frequency) breaking ties - and return the top `k`.
 *
 * The two axes are NORMALIZED across the candidate set before being blended: they are otherwise on
 * incompatible scales, and the raw sum this used to compute silently handed the ranking to whichever
 * one had the wider spread (see `activationWeight`). An empty query scores every belief 0, the
 * relevance spread degenerates to 0, and the ranking falls back to pure activation order - the
 * most top-of-mind beliefs, i.e. the profile. That fallback is intentional and preserved.
 */
export function recall(beliefs: readonly Belief[], query: string, options: RecallOptions = {}): RecalledBelief[] {
  const scorer = options.scorer ?? lexicalScorer;
  const activationWeight = options.activationWeight ?? DEFAULT_ACTIVATION_WEIGHT;
  const k = options.k ?? DEFAULT_K;
  const minRelevance = options.minRelevance ?? 0;

  // Score, then apply the floor on RAW relevance, then normalize over what survives - so the
  // normalization describes the beliefs actually in contention.
  const candidates = beliefs
    .map(belief => ({ belief, relevance: scorer(query, belief), activation: belief.activation ?? 0 }))
    .filter(c => c.relevance >= minRelevance);

  if (candidates.length === 0) return [];

  const normRel = normalizer(candidates.map(c => c.relevance));
  const normAct = normalizer(candidates.map(c => c.activation));

  return candidates
    .map(
      (c): RecalledBelief => ({
        belief: c.belief,
        relevance: c.relevance,
        score: normRel(c.relevance) + activationWeight * normAct(c.activation),
      })
    )
    .sort((a, b) => b.score - a.score || b.relevance - a.relevance || a.belief.id.localeCompare(b.belief.id))
    .slice(0, k);
}
