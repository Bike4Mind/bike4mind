/**
 * The two retrieval policies, expressed as pure functions over the SAME belief set so they can be
 * judged on identical footing. This is the head-to-head the V1/V2 deployment model turns on: V2 only
 * earns the right to retire V1 if its read path is at least as good.
 *
 * Both take beliefs that already carry embeddings and a query that is already embedded, so the eval
 * measures the POLICY (what to surface, and in what order) rather than the embedding provider.
 */

import { cosineSimilarity, recall, embeddingScorer } from '../recall';
import type { Belief } from '../types';

/** What a policy hands to the prompt: belief ids, best first. */
export type Retrieved = string[];

export interface V1Options {
  /** V1 ships topK 10. */
  topK?: number;
  /**
   * V1's topicality floor. `getRelevantMementos` defaults to 0.7 and the chat calls it with 0.75:
   * a memento below that cosine is NOT injected at all. This floor is the whole reason V1 stays
   * quiet on an off-topic question - and the thing V2 currently has no answer to.
   */
  minSimilarity?: number;
}

/**
 * V1: pure vector search over the user's mementos. Rank by cosine to the query, drop everything
 * below `minSimilarity`, keep the top K. No recency, no frequency - similarity is the whole story.
 * Mirrors `getRelevantMementos` (b4m-core/services/src/mementoService).
 */
export function retrieveV1(beliefs: readonly Belief[], queryEmbedding: readonly number[], options: V1Options = {}): Retrieved {
  const topK = options.topK ?? 10;
  const minSimilarity = options.minSimilarity ?? 0.75;

  return beliefs
    .filter(b => b.embedding?.length)
    .map(b => ({ id: b.id, sim: cosineSimilarity(queryEmbedding, b.embedding!) }))
    .filter(r => r.sim >= minSimilarity)
    .sort((a, b) => b.sim - a.sim || a.id.localeCompare(b.id))
    .slice(0, topK)
    .map(r => r.id);
}

export interface V2Options {
  k?: number;
  /** How much heat may reorder topicality. Defaults to whatever `recall` ships. */
  activationWeight?: number;
  /**
   * Topicality floor. Defaults to 0 (`recall`'s default: keep everything, so an empty query still
   * degrades to the profile). Production supplies a floor calibrated to the embedding model in use -
   * see MIN_RELEVANCE_BY_MODEL in apps/client/server/memory/recallMementosV2.ts, and `tuning.test.ts`
   * here for how that number is chosen.
   */
  minRelevance?: number;
}

/**
 * V2: the shipped `recall()` - ACT-R retrieval score (activation + weighted semantic relevance) over
 * the ledger-unioned belief set. Calls the real engine, not a re-implementation, so the eval cannot
 * drift away from what production does.
 *
 * `queryText` is passed through (not just the vector) because that is what production does: the
 * embedding scorer falls back to lexical overlap for any belief that carries no embedding, and an
 * empty query would silently score every one of those 0.
 */
export function retrieveV2(
  beliefs: readonly Belief[],
  queryEmbedding: readonly number[],
  queryText: string,
  options: V2Options = {}
): Retrieved {
  return recall(beliefs, queryText, {
    k: options.k ?? 10,
    ...(options.activationWeight === undefined ? {} : { activationWeight: options.activationWeight }),
    ...(options.minRelevance === undefined ? {} : { minRelevance: options.minRelevance }),
    scorer: embeddingScorer(queryEmbedding),
  }).map(r => r.belief.id);
}
