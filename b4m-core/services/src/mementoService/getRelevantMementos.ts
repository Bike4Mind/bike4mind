import {
  IAdminSettingsRepository,
  IApiKeyRepository,
  IMementoDocument,
  IMementoRepository,
  MEMENTO_MIN_SIMILARITY,
  MementoTier,
  mementoEmbeddingIsCurrent,
} from '@bike4mind/common';
import { computeCosineSimilarity } from '@bike4mind/utils';
import { Logger } from '@bike4mind/observability';
import { BoundedTopK } from '../dataLakeService';
import { embedMementoQuery } from './embedMementoQuery';

/**
 * Page size for the memento walk, and a sanity bound on how many pages it may take.
 *
 * The bound is NOT a coverage budget: hitting it THROWS rather than quietly returning a prefix,
 * because a scan that stops short without saying so is the failure this change exists to remove.
 * It is set far past any real account (400,000 mementos), so reaching it means the repository is
 * misbehaving - returning rows out of `_id` order, or ignoring the cursor in a way the strict
 * advance check below cannot see. Cursor advance alone proves PROGRESS, not termination.
 *
 * MUST STAY IN SYNC with PROFILE_MAX_PAGES in
 * apps/client/server/memory/userMementoMemoryStore.ts: the two walk the same collection for the
 * same user on the V1 and V2 paths, so ceilings that drift apart would make a user's memory depend
 * on which path served the turn. Deliberately not one shared export - they sit in different
 * packages and neither should take a dependency on the other to hold a number.
 */
const MEMENTO_PAGE_SIZE = 200;
const MEMENTO_MAX_PAGES = 2_000;

/**
 * Result type for memento retrieval with similarity score
 */
export interface RelevantMemento {
  memento: IMementoDocument;
  similarity: number;
}

/**
 * Total order for the top-K. The id tiebreaker is load-bearing, not cosmetic: mementos now arrive
 * page by page, so leaving equal-similarity mementos to arrival order would make the result depend
 * on where a page boundary fell.
 *
 * Byte comparison, NOT localeCompare, matching `compareRankedChunks` in `@bike4mind/utils`: the cursor
 * check and Mongo's `_id` ascending sort both order these ids bytewise, and a collation-aware
 * comparator over the same key is how the determinism this tiebreaker provides would quietly erode.
 */
const compareMementosBySimilarity = (a: RelevantMemento, b: RelevantMemento) => {
  const byScore = b.similarity - a.similarity;
  if (byScore !== 0) return byScore;
  const [x, y] = [String(a.memento.id), String(b.memento.id)];
  return x < y ? -1 : x > y ? 1 : 0;
};

/**
 * Options for memento retrieval
 */
export interface GetRelevantMementosOptions {
  /**
   * Number of top mementos to return (default: 5)
   */
  topK?: number;

  /**
   * Minimum similarity threshold (0-1 scale). Only mementos scoring at or above it are returned.
   *
   * Omit it. Retrieval is pinned to the memento embedding space (`MEMENTO_EMBEDDING_ID`), so the
   * floor is `MEMENTO_MIN_SIMILARITY` - a single measured constant, not a per-space lookup. Passing
   * a number here asserts you know better than that measurement, which tests do and callers
   * generally do not.
   */
  minSimilarity?: number;

  /**
   * Which tier of mementos to search (default: 'hot')
   * - 'hot': Only search HOT tier (most relevant personal info)
   * - 'all': Search all tiers
   */
  tier?: MementoTier | 'all';

  /**
   * Optional logger for debugging
   */
  logger?: Logger;
}

/**
 * Adapters required for memento retrieval
 */
export interface GetRelevantMementosAdapters {
  db: {
    mementos: IMementoRepository;
    apiKeys: Pick<IApiKeyRepository, 'findByUserIdAndTypes' | 'findByUserIdAndType'>;
    adminSettings: IAdminSettingsRepository;
  };
}

/**
 * Retrieves the most relevant personal memories for a given user prompt
 * Uses vector similarity search to find semantically similar mementos
 *
 * @param userId - The user's ID to fetch mementos for
 * @param prompt - The current user prompt to search against
 * @param options - Configuration options for retrieval
 * @param adapters - Database and service adapters
 * @returns Array of mementos with their similarity scores, sorted by relevance
 *
 * @example
 * ```typescript
 * const mementos = await getRelevantMementos(
 *   'user123',
 *   'How do I use React hooks?',
 *   { topK: 5 },
 *   { db: { mementos, apiKeys, adminSettings } }
 * );
 *
 * // Returns up to 5 mementos about React, programming preferences, etc.
 * // Each with a similarity score (0-1)
 * ```
 */
export async function getRelevantMementos(
  userId: string,
  prompt: string,
  options: GetRelevantMementosOptions = {},
  adapters: GetRelevantMementosAdapters
): Promise<RelevantMemento[]> {
  const { topK = 5, minSimilarity: providedMinSimilarity, tier = MementoTier.HOT, logger } = options;

  logger?.updateMetadata({
    promptLength: prompt.length,
  });

  const minSimilarity = providedMinSimilarity ?? MEMENTO_MIN_SIMILARITY;

  try {
    // STEP 1: Embed the query in the memento space. Converge on the memento space rather than
    // resolving it dynamically per-user - see MEMENTO_EMBEDDING_ID's docblock. A missing credential
    // or provider error comes back as the empty sentinel, not a throw: memory is enrichment, not a
    // requirement, so a keyless stage returns no mementos rather than failing the turn.
    const { vector: promptEmbedding } = await embedMementoQuery(
      userId,
      prompt,
      { db: { apiKeys: adapters.db.apiKeys, adminSettings: adapters.db.adminSettings } },
      { logger }
    );
    if (promptEmbedding.length === 0) {
      logger?.warn?.('[getRelevantMementos] could not embed the query (no credential or provider error); skipping');
      return [];
    }

    // STEP 2+3: Walk the user's mementos a page at a time, scoring into a fixed-size top-K.
    //
    // Every memento carries an embedding and its full original prompt, so reading them all at once
    // made peak memory a function of how long the user has been using the product. Paging bounds that
    // to one page plus topK. The walk runs to the end unconditionally, so which mementos get scored is
    // exactly what it was before - only peak memory changed.
    //
    // No `.lean()`: RelevantMemento.memento is an IMementoDocument and consumers read `memento.id`,
    // a Mongoose virtual that a lean object does not carry.
    const ranked = new BoundedTopK<RelevantMemento>(topK, compareMementosBySimilarity);
    let scanned = 0;
    let staleSkipped = 0;
    let cursor: string | undefined;

    for (let page = 0; ; page++) {
      if (page > MEMENTO_MAX_PAGES) {
        throw new Error(
          `[getRelevantMementos] memento walk exceeded ${MEMENTO_MAX_PAGES} pages for user ${userId}; ` +
            `refusing to score a prefix silently`
        );
      }
      const mementos = await adapters.db.mementos.findByUserId(userId, {
        tier: tier === 'all' ? undefined : tier,
        select: 'summary embedding embeddingModel weight tags fullContent lastAccessedAt',
        limit: MEMENTO_PAGE_SIZE,
        afterId: cursor,
      });
      if (mementos.length === 0) break;

      const nextCursor = String(mementos[mementos.length - 1].id);
      if (cursor !== undefined && !(nextCursor > cursor)) {
        throw new Error(`[getRelevantMementos] memento cursor failed to advance past ${cursor} for user ${userId}`);
      }
      cursor = nextCursor;

      for (const memento of mementos) {
        scanned++;
        if (!memento.embedding || memento.embedding.length === 0) {
          logger?.warn?.(`Memento ${memento.id} missing embedding, skipping`);
          continue;
        }
        // Pre-migration mementos carry a vector from a different embedding space; cosine against
        // them is meaningless, not just stale, so they are excluded rather than scored low.
        if (!mementoEmbeddingIsCurrent(memento)) {
          staleSkipped++;
          continue;
        }

        const similarity = computeCosineSimilarity(promptEmbedding, memento.embedding);
        // A zero-magnitude embedding makes cosine NaN, and NaN fails every comparison - it would slip
        // past the floor below and then sort ahead of every real match. An exact 0 is also suspect
        // here: computeCosineSimilarity returns exactly 0 (not NaN) on a vector-width mismatch, which
        // the embeddingModel gate above should already have ruled out for anything reaching this line.
        if (!Number.isFinite(similarity) || similarity === 0) {
          logger?.warn?.(`Memento ${memento.id} scored a non-finite or exact-zero similarity, skipping`);
          continue;
        }
        if (similarity < minSimilarity) continue;

        ranked.offer({ memento, similarity });
      }

      if (mementos.length < MEMENTO_PAGE_SIZE) break;
    }

    logger?.debug?.(`Scanned ${scanned} mementos (tier: ${tier}), ${staleSkipped} excluded as pre-migration`);

    if (scanned === 0) {
      logger?.debug?.('No mementos found for user');
      return [];
    }

    // Highest similarity first
    const sortedMementos = ranked.drain();

    logger?.debug?.(
      `Returning ${sortedMementos.length} relevant mementos (min similarity: ${minSimilarity}, topK: ${topK})`
    );

    if (sortedMementos.length > 0) {
      logger?.debug?.(
        `Top memento similarity: ${sortedMementos[0].similarity.toFixed(3)} - "${sortedMementos[0].memento.summary}"`
      );
    }

    return sortedMementos;
  } catch (error) {
    // Fail open: personal memory enriches an answer, it is not required to produce one. But the
    // message has to name the actual failure - this block covers the whole retrieval, not just the
    // embed call, so attributing every fault to embedding generation sends someone hunting the wrong
    // thing (a paging fault, for instance, reads nothing like a provider error).
    logger?.warn?.('Memento retrieval failed, continuing without personal memory:', error);
    return [];
  }
}
