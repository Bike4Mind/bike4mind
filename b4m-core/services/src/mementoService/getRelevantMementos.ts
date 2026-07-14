import {
  IAdminSettingsRepository,
  IApiKeyRepository,
  IMementoDocument,
  IMementoRepository,
  MementoTier,
  SupportedEmbeddingModel,
  MEMENTO_EMBEDDING_MODEL,
  MEMENTO_MIN_SIMILARITY,
  mementoEmbeddingIsCurrent,
  toMementoVector,
} from '@bike4mind/common';
import { computeCosineSimilarity, EmbeddingFactory, getProviderFromModel, getSettingsByNames } from '@bike4mind/utils';
import { Logger } from '@bike4mind/observability';
import { getEffectiveLLMApiKeys } from '../apiKeyService';

/**
 * Result type for memento retrieval with similarity score
 */
export interface RelevantMemento {
  memento: IMementoDocument;
  similarity: number;
}

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
  const {
    topK = 5,
    minSimilarity = MEMENTO_MIN_SIMILARITY,
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

  // STEP 2: Get embedding model. Mementos pin their own (MEMENTO_EMBEDDING_MODEL) rather than
  // following the `defaultEmbeddingModel` setting that governs the FAB file corpus - the query MUST
  // land in the same vector space the mementos were written in, and the two corpora migrate apart.
  const embeddingModel = providedEmbeddingModel ?? MEMENTO_EMBEDDING_MODEL;

  logger?.debug?.('Using embedding model for memento retrieval:', embeddingModel);

  // STEP 3: Setup embedding service
  const requiredProvider = getProviderFromModel(embeddingModel);
  const embeddingConfig: { openaiApiKey?: string | null; voyageApiKey?: string | null } = {};

  if (requiredProvider === 'openai') {
    if (!apiKeyTable?.openai) {
      throw new Error('OpenAI API key is required for memento retrieval but not found.');
    }
    embeddingConfig.openaiApiKey = apiKeyTable.openai;
  } else if (requiredProvider === 'voyageai') {
    if (!apiKeyTable?.voyageai) {
      throw new Error('VoyageAI API key is required for memento retrieval but not found.');
    }
    embeddingConfig.voyageApiKey = apiKeyTable.voyageai;
  }

  const embeddingFactory = new EmbeddingFactory(embeddingConfig);
  const embeddingService = embeddingFactory.createEmbeddingService(embeddingModel);

  // STEP 4: Generate embedding for user prompt
  logger?.debug?.('Generating embedding for prompt:', prompt.substring(0, 100));
  try {
    // Same vector space as the stored mementos - see toMementoVector.
    const promptEmbedding = toMementoVector(await embeddingService.generateEmbedding(prompt));
    // STEP 5: Fetch mementos from database
    const mementos = await adapters.db.mementos.findByUserId(userId, {
      tier: tier === 'all' ? undefined : tier,
      select: 'summary embedding embeddingModel weight tags fullContent lastAccessedAt',
    });

    logger?.debug?.(`Found ${mementos.length} mementos to search through (tier: ${tier})`);

    if (mementos.length === 0) {
      logger?.debug?.('No mementos found for user');
      return [];
    }

    // STEP 6: Compute similarity scores
    let staleSpace = 0;
    const mementosWithScores: RelevantMemento[] = mementos.reduce<RelevantMemento[]>((acc, memento) => {
      if (!memento.embedding || memento.embedding.length === 0) {
        logger?.warn?.(`Memento ${memento.id} missing embedding, skipping`);
        return acc;
      }

      // A vector from another model's space is not comparable to this query - the cosine would be
      // noise. Skip rather than score: an unrelated number here silently either buries real memories
      // or promotes junk, and both look like the system working.
      if (!mementoEmbeddingIsCurrent(memento)) {
        staleSpace += 1;
        return acc;
      }

      const similarity = computeCosineSimilarity(promptEmbedding, memento.embedding);

      // Only include if above minimum threshold
      if (similarity >= minSimilarity) {
        acc.push({
          memento,
          similarity,
        });
      }

      return acc;
    }, []);

    if (staleSpace > 0) {
      // Loud, because the symptom is invisible: memory just quietly knows less. Cleared by the
      // memento re-embed backfill.
      logger?.warn?.(
        `${staleSpace} of ${mementos.length} mementos were embedded with a different model than ${embeddingModel} and were skipped; run the memento re-embed backfill`
      );
    }

    // STEP 7: Sort by similarity (highest first) and limit to topK
    const sortedMementos = mementosWithScores.sort((a, b) => b.similarity - a.similarity).slice(0, topK);

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
    logger?.warn?.('Error generating embedding for prompt, returning empty array:', error);
    return [];
  }
}
