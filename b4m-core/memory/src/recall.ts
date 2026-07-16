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

/**
 * A relevance score. A bare number is on the scorer's PRIMARY scale (the scale `minRelevance` is
 * expressed in). `{ relevance, offScale: true }` signals the score came from a fallback on a DIFFERENT
 * scale - e.g. the embedding scorer dropping to lexical Jaccard for a belief that has no vector - so
 * recall must NOT judge it against the primary (cosine) floor. Mixing scales silently was a real bug:
 * a 0.25 cosine floor applied to a Jaccard score (which paraphrases rarely push past 0.05) dropped
 * every embedding-less belief, killing the very fallback that exists to keep a mixed set audible.
 */
export type RelevanceScore = number | { relevance: number; offScale: boolean };

export type RecallScorer = (query: string, belief: Belief) => RelevanceScore;

const normalizeScore = (s: RelevanceScore): { relevance: number; offScale: boolean } =>
  typeof s === 'number' ? { relevance: s, offScale: false } : s;

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
      : // No usable vector: score by the fallback, but FLAG it off-scale so recall floors it on the
        // lexical scale, not the cosine one. Otherwise the cosine floor silently drops it.
        { relevance: normalizeScore(fallback(query, belief)).relevance, offScale: true };
}

export interface RecallOptions {
  /** Relevance scorer; defaults to the pure lexical overlap. Supply embedding similarity at the host. */
  scorer?: RecallScorer;
  /** Maximum results to return. */
  k?: number;
  /**
   * How far a belief's ACT-R activation may move it relative to topicality: `score = relevance +
   * activationWeight * recallProbability(activation)`. Because activation is squashed into 0..1, this
   * is the maximum cosine a belief can gain by being maximally top-of-mind - so it reads directly as
   * "how much similarity is a hot memory worth".
   *
   * Default 0.025, and the window is NARROW - the eval corpus walls it in on both sides, close together:
   *   - below ~0.01 heat is too weak to settle a genuine tie: a fact the user has RETRACTED still
   *     outranks the retraction (the two are equally on-topic by construction), and recall confidently
   *     serves a belief its owner has taken back.
   *   - by ~0.05 heat has stopped breaking ties and started overriding topic: ranking quality falls as
   *     merely-recent beliefs climb over the on-topic one.
   * 0.025 is the midpoint of the only band that satisfies both. Treat this as a delicate knob, not a
   * dial to taste: re-run the sweep rather than nudging it, and note the band MOVES with BOTH
   * `minRelevance` and the embedding width - narrowing the vector rescales every cosine, which rescales
   * how much a unit of heat is worth against it.
   *
   * Do NOT normalize relevance to make this weight "feel" scale-free - see `recallProbability`. The
   * whole point is that relevance keeps its true magnitudes, so a near-tie stays a near-tie and heat
   * is allowed to settle it.
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
  /**
   * Floor for OFF-SCALE scores - beliefs the scorer could only judge by the lexical fallback (no
   * vector). `minRelevance` is a cosine and cannot be applied to a Jaccard score, so these get their
   * own bar. Default 0.1: a genuinely word-matching belief still surfaces, pure noise (Jaccard ~0)
   * stays out. Only relevant when a scorer returns off-scale scores (the embedding scorer's fallback).
   */
  lexicalMinRelevance?: number;
}

export interface RecalledBelief {
  belief: Belief;
  /** The scorer's relevance for this query, 0..1 for the lexical default. */
  relevance: number;
  /** relevance + activationWeight * recallProbability(activation) - what this ranks by. */
  score: number;
}

const DEFAULT_K = 8;
const DEFAULT_ACTIVATION_WEIGHT = 0.025;
/** Bar for lexical-fallback (off-scale) scores; keeps word-matching beliefs, drops Jaccard-0 noise. */
const DEFAULT_LEXICAL_MIN_RELEVANCE = 0.1;

/**
 * Squash an unbounded ACT-R activation into 0..1 - the recall PROBABILITY of a belief with that
 * activation, which is ACT-R's own retrieval equation (P = 1 / (1 + e^-((A - tau) / s))) at tau = 0,
 * s = 1. So this is not an arbitrary sigmoid picked to make the numbers behave; it is the model's
 * native way of turning "how top-of-mind is this" into a bounded quantity.
 *
 * Bounding activation is the ONLY normalization recall needs. Relevance arrives already bounded and
 * already calibrated (a cosine, or the lexical Jaccard), so its absolute differences MEAN something
 * and are left alone. Min-maxing relevance across the candidate set - which this used to do - is
 * actively wrong: it rescales whatever spread happens to be present up to the full 0..1 range, so two
 * beliefs that are all but equally on-topic get torn apart into 1.0 and 0.0. With a small candidate
 * set that is catastrophic. Measured: a user states a preference, later retracts it, and asks about
 * it. Both beliefs clear the floor at cosine 0.366 and 0.363 (fixture, 512-dim) - a ~0.003 gap, a tie. Min-max
 * turned that tie into the maximum possible gap, and activation could not overturn it at ANY weight:
 * recall confidently served the fact the user had explicitly taken back.
 */
const recallProbability = (activation: number): number => 1 / (1 + Math.exp(-activation));

/**
 * Rank a principal's beliefs for a query by ACT-R retrieval score - topicality (associative match)
 * led, activation (recency + frequency) breaking ties - and return the top `k`.
 *
 * Relevance is used RAW and activation is squashed into 0..1 (see `recallProbability`), so the two
 * are commensurable without distorting either. Activation alone needs bounding: it is an unbounded log
 * quantity, and summing it raw against a cosine hands the ranking entirely to heat - measured on the
 * eval corpus, an unbounded sum dropped hit rate to 69% where plain vector search got 100%.
 *
 * An empty query scores every belief 0, so the ranking falls back to pure activation order - the most
 * top-of-mind beliefs, i.e. the profile. That fallback is intentional and preserved.
 */
export function recall(beliefs: readonly Belief[], query: string, options: RecallOptions = {}): RecalledBelief[] {
  const scorer = options.scorer ?? lexicalScorer;
  const activationWeight = options.activationWeight ?? DEFAULT_ACTIVATION_WEIGHT;
  const k = options.k ?? DEFAULT_K;
  const minRelevance = options.minRelevance ?? 0;
  const lexicalMinRelevance = options.lexicalMinRelevance ?? DEFAULT_LEXICAL_MIN_RELEVANCE;

  // Score, then apply a SCALE-APPROPRIATE floor: cosine scores against `minRelevance`, lexical-fallback
  // (off-scale) scores against `lexicalMinRelevance`. A single floor across both scales is the bug this
  // guards against - a cosine 0.25 bar silently rejects every Jaccard score.
  const candidates = beliefs
    .map(belief => {
      const { relevance, offScale } = normalizeScore(scorer(query, belief));
      return { belief, relevance, offScale, activation: belief.activation ?? 0 };
    })
    .filter(c => c.relevance >= (c.offScale ? lexicalMinRelevance : minRelevance));

  if (candidates.length === 0) return [];

  return candidates
    .map(
      (c): RecalledBelief => ({
        belief: c.belief,
        relevance: c.relevance,
        score: c.relevance + activationWeight * recallProbability(c.activation),
      })
    )
    .sort((a, b) => b.score - a.score || b.relevance - a.relevance || a.belief.id.localeCompare(b.belief.id))
    .slice(0, k);
}
