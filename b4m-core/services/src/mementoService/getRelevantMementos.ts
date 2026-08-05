import {
  IAdminSettingsRepository,
  IApiKeyRepository,
  IMementoDocument,
  IMementoRepository,
  MementoTier,
  SupportedEmbeddingModel,
  isSupportedEmbeddingModel,
} from '@bike4mind/common';
import {
  computeCosineSimilarity,
  EmbeddingFactory,
  getProviderFromModel,
  getSettingsByNames,
  resolveEmbeddingConfig,
} from '@bike4mind/utils';
import { Logger } from '@bike4mind/observability';
import { getEffectiveLLMApiKeys } from '../apiKeyService';
import { BoundedTopK } from '../dataLakeService';

/**
 * Page size for the memento walk, and a sanity bound on how many pages it may take.
 *
 * The bound is NOT a coverage budget: hitting it THROWS rather than quietly returning a prefix,
 * because a scan that stops short without saying so is the failure this change exists to remove.
 * It is set far past any real account (400,000 mementos), so reaching it means the repository is
 * misbehaving - returning rows out of `_id` order, or ignoring the cursor in a way the strict
 * advance check below cannot see. Cursor advance alone proves PROGRESS, not termination.
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
 */
const compareMementosBySimilarity = (a: RelevantMemento, b: RelevantMemento) =>
  b.similarity - a.similarity || String(a.memento.id).localeCompare(String(b.memento.id));

/**
 * Options for memento retrieval
 */
export interface GetRelevantMementosOptions {
  /**
   * Number of top mementos to return (default: 5)
   */
  topK?: number;

  /**
   * Minimum similarity threshold (0-1 scale, default: 0.7)
   * Only mementos with similarity >= this threshold will be returned
   */
  minSimilarity?: number;

  /**
   * Which tier of mementos to search (default: 'hot')
   * - 'hot': Only search HOT tier (most relevant personal info)
   * - 'all': Search all tiers
   */
  tier?: MementoTier | 'all';

  /**
   * Optional embedding model to use (if not provided, will fetch from admin settings)
   */
  embeddingModel?: SupportedEmbeddingModel;

  /**
   * Optional API key table (if not provided, will fetch for user)
   */
  apiKeyTable?: {
    openai?: string | null;
    anthropic?: string | null;
    gemini?: string | null;
    voyageai?: string | null;
    ollama?: string | null;
  };

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
 *   { topK: 5, minSimilarity: 0.7 },
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
  const {
    topK = 5,
    minSimilarity = 0.7,
    tier = MementoTier.HOT,
    embeddingModel: providedEmbeddingModel,
    apiKeyTable: providedApiKeyTable,
    logger,
  } = options;

  logger?.updateMetadata({
    promptLength: prompt.length,
  });

  // STEP 1: Get API keys (if not provided)
  const apiKeyTable =
    providedApiKeyTable ||
    (await getEffectiveLLMApiKeys(
      userId,
      {
        db: {
          apiKeys: adapters.db.apiKeys,
          adminSettings: adapters.db.adminSettings,
        },
        getSettingsByNames,
      },
      { logger }
    ));

  // STEP 2: Get embedding model (if not provided)
  let embeddingModel = providedEmbeddingModel;
  if (!embeddingModel) {
    const defaultModel = await adapters.db.adminSettings.getSettingsValue('defaultEmbeddingModel');
    if (!defaultModel || !isSupportedEmbeddingModel(defaultModel)) {
      throw new Error('Default embedding model not configured. Please configure it in admin settings.');
    }
    embeddingModel = defaultModel as SupportedEmbeddingModel;
  }

  logger?.debug?.('Using embedding model for memento retrieval:', embeddingModel);

  // STEP 3: Setup embedding service
  const requiredProvider = getProviderFromModel(embeddingModel);
  const { config: embeddingConfig, missing } = resolveEmbeddingConfig(requiredProvider, apiKeyTable);
  if (missing) {
    throw new Error(
      missing === 'ollama'
        ? 'Ollama base URL is required for memento retrieval but not found.'
        : `${missing === 'openai' ? 'OpenAI' : 'VoyageAI'} API key is required for memento retrieval but not found.`
    );
  }

  const embeddingFactory = new EmbeddingFactory(embeddingConfig);
  const embeddingService = embeddingFactory.createEmbeddingService(embeddingModel);

  // STEP 4: Generate embedding for user prompt
  logger?.debug?.('Generating embedding for prompt:', prompt.substring(0, 100));
  try {
    const promptEmbedding = await embeddingService.generateEmbedding(prompt);

    // STEP 5+6: Walk the user's mementos a page at a time, scoring into a fixed-size top-K.
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
        select: 'summary embedding weight tags fullContent lastAccessedAt',
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

        const similarity = computeCosineSimilarity(promptEmbedding, memento.embedding);
        // A zero-magnitude embedding makes cosine NaN, and NaN fails every comparison - it would slip
        // past the floor below and then sort ahead of every real match.
        if (!Number.isFinite(similarity)) {
          logger?.warn?.(`Memento ${memento.id} scored a non-finite similarity, skipping`);
          continue;
        }
        if (similarity < minSimilarity) continue;

        ranked.offer({ memento, similarity });
      }

      if (mementos.length < MEMENTO_PAGE_SIZE) break;
    }

    logger?.debug?.(`Scanned ${scanned} mementos (tier: ${tier})`);

    if (scanned === 0) {
      logger?.debug?.('No mementos found for user');
      return [];
    }

    // STEP 7: Highest similarity first
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
