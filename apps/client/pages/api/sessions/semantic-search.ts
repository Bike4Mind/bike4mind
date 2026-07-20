/**
 * Hybrid Semantic Search API Endpoint
 *
 * Performs hybrid search combining keyword filtering with semantic similarity:
 * 1. First filters messages containing the search terms (keyword match)
 * 2. Then ranks by cosine similarity using embeddings
 *
 * This approach ensures results are both topically relevant AND semantically similar,
 * avoiding the "everything matches at 70%" problem with pure semantic search.
 *
 * TODO: Consider charging 1-10 credits for semantic search
 * This operation is expensive due to:
 * - Query embedding generation
 * - Fetching matching messages
 * - Cosine similarity computation
 */

import { Request, Response } from 'express';
import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { apiKeyRepository, adminSettingsRepository, sessionRepository } from '@bike4mind/database';
import { Quest } from '@bike4mind/database/content';
import { computeCosineSimilarity, getSettingsByNames } from '@bike4mind/utils';
import { EmbeddingFactory, getProviderFromModel } from '@bike4mind/fab-pipeline';
import { isSupportedEmbeddingModel, SupportedEmbeddingModel } from '@bike4mind/common';
import { apiKeyService, ReRankService, SmallLLMService } from '@bike4mind/services';
import { OperationsModelService } from '@client/services/operationsModelService';

interface SemanticSearchRequest {
  query: string;
  minSimilarity?: number; // Default: 0.3 (lower threshold since we pre-filter by keyword)
  topK?: number; // Default: 50 (max sessions to return)
  hybridMode?: boolean; // Default: true - require keyword match before semantic ranking
  useReRanking?: boolean; // Default: false - LLM re-ranking for quality verification
}

interface MessageMatch {
  similarity: number;
  snippet: string; // Extractive snippet showing why it matched
}

interface SessionScore {
  sessionId: string;
  sessionName?: string;
  maxSimilarity: number;
  matchingMessages: number;
  bestMatch?: MessageMatch; // Best matching message details for debugging
}

const handler = baseApi().post(
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const {
      query,
      minSimilarity = 0.3,
      topK = 50,
      hybridMode = true,
      useReRanking = false,
    } = req.body as SemanticSearchRequest;

    if (!query || query.trim().length === 0) {
      return res.status(400).json({ error: 'Query is required' });
    }

    req.logger?.updateMetadata({
      endpoint: 'sessions/semantic-search',
      queryLength: query.length,
      minSimilarity,
      topK,
      hybridMode,
    });

    // STEP 0: Expand query with spelling correction and synonyms
    let correctedQuery = query;
    let keywords: string[] = [];
    let queryExpansionTimeMs = 0;

    if (hybridMode) {
      try {
        const expansionStart = Date.now();
        const { modelId, llm } = await OperationsModelService.getOperationsModel();
        const smallLLM = new SmallLLMService({ llm, modelId }, req.logger);

        const { data: expansion } = await smallLLM.expandQuery(query, { timeoutMs: 3000 });
        correctedQuery = expansion.corrected;
        keywords = expansion.keywords
          .map(k =>
            k
              .toLowerCase()
              .replace(/[^a-z0-9\s]/g, '')
              .trim()
          )
          .filter(k => k.length >= 2);

        queryExpansionTimeMs = Date.now() - expansionStart;
        req.logger?.info?.(
          `Query expansion: "${query}" → "${correctedQuery}" with ${keywords.length} keywords in ${queryExpansionTimeMs}ms`
        );
      } catch (expansionError) {
        // Fallback to simple keyword extraction if LLM fails
        req.logger?.warn?.('Query expansion failed, using simple extraction:', expansionError);
        keywords = query
          .toLowerCase()
          .split(/\s+/)
          .filter(word => word.length >= 3)
          .map(word => word.replace(/[^a-z0-9]/g, ''))
          .filter(word => word.length >= 3);
      }
    }

    req.logger?.debug?.('Hybrid mode:', hybridMode, 'Keywords:', keywords);

    try {
      // STEP 1: Get API keys for embedding generation
      const apiKeyTable = await apiKeyService.getEffectiveLLMApiKeys(
        userId,
        {
          db: {
            apiKeys: apiKeyRepository,
            adminSettings: adminSettingsRepository,
          },
          getSettingsByNames,
        },
        { logger: req.logger }
      );
      req.logger?.debug?.('API keys retrieved:', {
        hasOpenAI: !!apiKeyTable?.openai,
        hasVoyageAI: !!apiKeyTable?.voyageai,
      });

      // STEP 2: Get embedding model from admin settings
      req.logger?.debug?.('Getting default embedding model');
      const defaultEmbeddingModel = await adminSettingsRepository.getSettingsValue('defaultEmbeddingModel');
      req.logger?.debug?.('Default embedding model:', defaultEmbeddingModel);

      if (!defaultEmbeddingModel || !isSupportedEmbeddingModel(defaultEmbeddingModel)) {
        return res.status(500).json({
          error: 'Embedding model not configured. Please contact support.',
        });
      }

      const embeddingModel = defaultEmbeddingModel as SupportedEmbeddingModel;

      // STEP 3: Setup embedding service
      const requiredProvider = getProviderFromModel(embeddingModel);
      req.logger?.debug?.('Required provider for model:', requiredProvider);
      const embeddingConfig: {
        openaiApiKey?: string | null;
        voyageApiKey?: string | null;
        ollamaBaseUrl?: string | null;
      } = {};

      if (requiredProvider === 'openai') {
        if (!apiKeyTable?.openai) {
          req.logger?.error?.('OpenAI API key not configured');
          return res.status(400).json({
            error: `OpenAI API key is required for semantic search (model: ${embeddingModel}) but not configured. Please add your OpenAI API key in Settings, or contact your administrator.`,
          });
        }
        embeddingConfig.openaiApiKey = apiKeyTable.openai;
      } else if (requiredProvider === 'voyageai') {
        if (!apiKeyTable?.voyageai) {
          req.logger?.error?.('VoyageAI API key not configured');
          return res.status(400).json({
            error: `VoyageAI API key is required for semantic search (model: ${embeddingModel}) but not configured. Please add your VoyageAI API key in Settings, or contact your administrator.`,
          });
        }
        embeddingConfig.voyageApiKey = apiKeyTable.voyageai;
      } else if (requiredProvider === 'ollama') {
        // apiKeyTable.ollama carries the Ollama base URL (no secret) in self-host.
        if (!apiKeyTable?.ollama) {
          req.logger?.error?.('Ollama base URL not configured');
          return res.status(400).json({
            error: `Ollama base URL is required for semantic search (model: ${embeddingModel}) but not configured. Set OLLAMA_BASE_URL or configure Ollama in Settings.`,
          });
        }
        embeddingConfig.ollamaBaseUrl = apiKeyTable.ollama;
      } else {
        req.logger?.error?.('Unsupported embedding provider:', requiredProvider);
        return res.status(400).json({
          error: `Unsupported embedding provider: ${requiredProvider}. Please configure a supported embedding model.`,
        });
      }

      req.logger?.debug?.('Creating embedding service with config:', {
        hasOpenAIKey: !!embeddingConfig.openaiApiKey,
        hasVoyageKey: !!embeddingConfig.voyageApiKey,
        hasOllamaBaseUrl: !!embeddingConfig.ollamaBaseUrl,
        model: embeddingModel,
      });
      const embeddingFactory = new EmbeddingFactory(embeddingConfig);
      const embeddingService = embeddingFactory.createEmbeddingService(embeddingModel);

      // STEP 4: Generate embedding for user's query
      req.logger?.debug?.('Generating embedding for query:', query.substring(0, 50) + '...');
      const queryEmbedding = await embeddingService.generateEmbedding(query);
      req.logger?.debug?.('Query embedding generated, dimensions:', queryEmbedding.length);

      // STEP 5: Get all session IDs for the user
      req.logger?.debug?.('Getting session IDs for user');
      const sessionIds = await sessionRepository.findSessionIdsByUserId(userId);
      req.logger?.debug?.('Found session IDs:', sessionIds.length);

      if (sessionIds.length === 0) {
        return res.json({ sessionIds: [], count: 0 });
      }

      req.logger?.debug?.(`Found ${sessionIds.length} sessions to search through`);

      // STEP 6: Fetch messages for user's sessions
      // In hybrid mode: first filter by keyword match, then rank by semantic similarity
      // In pure semantic mode: fetch all messages and rank by similarity only
      const BATCH_SIZE = 100;
      const sessionScores: Map<string, SessionScore> = new Map();
      let messagesWithEmbedding = 0;
      let messagesGenerated = 0;
      let messagesSkipped = 0;
      let keywordMatchCount = 0;

      // PERFORMANCE SAFEGUARD: Limit on-the-fly embedding generation to prevent timeouts
      // Each embedding API call takes ~100-500ms, so 50 calls = 5-25 seconds max
      // Users with many unembedded messages should run Spider to pre-compute embeddings
      const MAX_ON_THE_FLY_EMBEDDINGS = 50;

      for (let i = 0; i < sessionIds.length; i += BATCH_SIZE) {
        const batchSessionIds = sessionIds.slice(i, i + BATCH_SIZE);

        // In hybrid mode, filter by keyword regex (case-insensitive) combined with the deletedAt check
        let messageQuery;

        if (hybridMode && keywords.length > 0) {
          const keywordPattern = keywords.join('|');
          messageQuery = {
            sessionId: { $in: batchSessionIds },
            $and: [
              { $or: [{ deletedAt: { $exists: false } }, { deletedAt: null }] },
              {
                $or: [
                  { prompt: { $regex: keywordPattern, $options: 'i' } },
                  { reply: { $regex: keywordPattern, $options: 'i' } },
                  { replies: { $elemMatch: { $regex: keywordPattern, $options: 'i' } } },
                ],
              },
            ],
          };
        } else {
          messageQuery = {
            sessionId: { $in: batchSessionIds },
            $or: [{ deletedAt: { $exists: false } }, { deletedAt: null }],
          };
        }

        // Fetch messages with their pre-computed embeddings if available
        // Include both 'reply' (single) and 'replies' (array) fields
        const messages = await Quest.find(messageQuery, {
          sessionId: 1,
          prompt: 1,
          reply: 1,
          replies: 1,
          embedding: 1,
        }).lean();

        if (hybridMode) {
          keywordMatchCount += messages.length;
        }

        // STEP 7: For each message, use pre-computed embedding or generate on-the-fly
        for (const message of messages) {
          try {
            let messageEmbedding: number[];

            // Use pre-computed embedding if available and model matches
            if (
              message.embedding?.vector &&
              message.embedding.vector.length > 0 &&
              message.embedding.model === embeddingModel
            ) {
              messageEmbedding = message.embedding.vector;
              messagesWithEmbedding++;
            } else {
              // Check if we've hit the on-the-fly generation limit
              if (messagesGenerated >= MAX_ON_THE_FLY_EMBEDDINGS) {
                messagesSkipped++;
                continue;
              }

              // Fall back to generating embedding on-the-fly
              // Combine prompt + reply + replies (array) for full content
              const msgWithReplies = message as typeof message & { replies?: string[] };
              const replyContent = message.reply || (msgWithReplies.replies?.join('\n\n') ?? '');
              let content = [message.prompt, replyContent].filter(Boolean).join('\n\n');

              if (!content || content.trim().length === 0) {
                continue;
              }

              // Truncate content if too long
              const MAX_CHARS = 30000; // ~7500 tokens, leaving buffer for safety
              if (content.length > MAX_CHARS) {
                content = content.substring(0, MAX_CHARS) + '...';
              }

              messageEmbedding = await embeddingService.generateEmbedding(content);
              messagesGenerated++;
            }

            const similarity = computeCosineSimilarity(queryEmbedding, messageEmbedding);

            if (similarity >= minSimilarity) {
              const sessionId = message.sessionId;
              const existing = sessionScores.get(sessionId);

              // Create snippet from the message content (first 200 chars of combined prompt+reply/replies)
              const msgWithReplies = message as typeof message & { replies?: string[] };
              const replyContent = message.reply || (msgWithReplies.replies?.join(' ') ?? '');
              const snippetContent = [message.prompt, replyContent].filter(Boolean).join(' | ');
              const snippet = snippetContent.length > 200 ? snippetContent.substring(0, 200) + '...' : snippetContent;

              if (existing) {
                existing.matchingMessages += 1;
                if (similarity > existing.maxSimilarity) {
                  existing.maxSimilarity = similarity;
                  existing.bestMatch = { similarity, snippet };
                }
              } else {
                sessionScores.set(sessionId, {
                  sessionId,
                  maxSimilarity: similarity,
                  matchingMessages: 1,
                  bestMatch: { similarity, snippet },
                });
              }
            }
          } catch (embeddingError) {
            // Skip messages that fail embedding generation
            req.logger?.warn?.('Failed to generate embedding for message:', embeddingError);
          }
        }
      }

      req.logger?.info?.(
        `${hybridMode ? 'HYBRID' : 'PURE SEMANTIC'} - Keyword matches: ${keywordMatchCount}, Embeddings: ${messagesWithEmbedding} pre-computed, ${messagesGenerated} generated, ${messagesSkipped} skipped`
      );

      if (messagesSkipped > 0) {
        req.logger?.warn?.(
          `Skipped ${messagesSkipped} messages due to on-the-fly embedding limit (${MAX_ON_THE_FLY_EMBEDDINGS}). Suggest running Spider to pre-compute embeddings.`
        );
      }

      // STEP 8: LLM Re-ranking (if enabled)
      let reRankingTimeMs = 0;
      let candidatesReRanked = 0;
      let candidatesFiltered = 0;
      const reRankingRequested = useReRanking && sessionScores.size > 0;
      let reRankingSucceeded = false;

      if (reRankingRequested) {
        const reRankStart = Date.now();
        const MAX_RERANK_CANDIDATES = 30;

        try {
          const { modelId, llm } = await OperationsModelService.getOperationsModel();
          const reRankService = new ReRankService({ llm, modelId }, req.logger);

          // Send top candidates by cosine to the LLM for relevance verification
          const candidates = Array.from(sessionScores.values())
            .sort((a, b) => b.maxSimilarity - a.maxSimilarity)
            .slice(0, MAX_RERANK_CANDIDATES)
            .map(s => ({
              id: s.sessionId,
              snippet: s.bestMatch?.snippet || '',
              cosineSimilarity: s.maxSimilarity,
            }));

          const reRanked = await reRankService.reRank(query, candidates, {
            maxCandidates: MAX_RERANK_CANDIDATES,
            minRelevanceScore: 3,
          });

          // Detect whether the re-ranker fell back to cosine-only scoring.
          // The fallback returns results with relevanceScore: -1
          const usedFallback = !reRanked.length || reRanked.every(result => result.relevanceScore === -1);

          if (!usedFallback) {
            candidatesReRanked = candidates.length;
            candidatesFiltered = candidates.length - reRanked.length;

            // Update scores for re-ranked sessions (keep maxSimilarity as cosine,
            // use finalScore for sorting only)
            for (const result of reRanked) {
              const session = sessionScores.get(result.id);
              if (session) {
                (session as SessionScore & { reRankScore?: number }).reRankScore = result.finalScore;
              }
            }

            // When re-ranking succeeds, restrict results to only the verified pool.
            // Sessions outside the top candidates were never verified by the LLM,
            // so they should not appear in "sorted by LLM relevance" results.
            const reRankedIds = new Set(reRanked.map(r => r.id));
            for (const sessionId of sessionScores.keys()) {
              if (!reRankedIds.has(sessionId)) {
                sessionScores.delete(sessionId);
              }
            }

            reRankingSucceeded = true;
            reRankingTimeMs = Date.now() - reRankStart;
            req.logger?.info?.(
              `Re-ranking: ${candidatesReRanked} candidates scored, ${candidatesFiltered} filtered out, took ${reRankingTimeMs}ms`
            );
          } else {
            // LLM re-ranking fell back to cosine-only scores; do not treat this as
            // a successful re-rank or restrict the candidate pool.
            reRankingTimeMs = Date.now() - reRankStart;
            req.logger?.warn?.(
              `Re-ranking fell back to cosine-only scoring; continuing with original results (took ${reRankingTimeMs}ms)`
            );
          }
        } catch (reRankError) {
          req.logger?.warn?.('Re-ranking failed, continuing with cosine-only results:', reRankError);
          // Continue with cosine-only results on failure
        }
      }

      // STEP 9: Sort by score and limit to topK
      // Use reRankScore when available (successful re-ranking), otherwise maxSimilarity
      const sortedSessions = Array.from(sessionScores.values())
        .sort((a, b) => {
          const aScore = (a as SessionScore & { reRankScore?: number }).reRankScore ?? a.maxSimilarity;
          const bScore = (b as SessionScore & { reRankScore?: number }).reRankScore ?? b.maxSimilarity;
          return bScore - aScore;
        })
        .slice(0, topK);

      const resultSessionIds = sortedSessions.map(s => s.sessionId);

      // STEP 10: Fetch session names for debug display
      if (resultSessionIds.length > 0) {
        const sessions = await sessionRepository.find({ _id: { $in: resultSessionIds } }, { _id: 1, name: 1 });
        const sessionNameMap = new Map(sessions.map(s => [s.id, s.name]));

        for (const score of sortedSessions) {
          score.sessionName = sessionNameMap.get(score.sessionId) || 'Untitled';
        }
      }

      req.logger?.debug?.(
        `Semantic search found ${resultSessionIds.length} matching sessions (min similarity: ${minSimilarity})`
      );

      req.logger?.info?.(
        `Results: ${resultSessionIds.length} sessions, top similarity: ${sortedSessions[0]?.maxSimilarity?.toFixed(3) || 'N/A'}`
      );

      const isPartial = messagesSkipped > 0;

      return res.json({
        sessionIds: resultSessionIds,
        count: resultSessionIds.length,
        scores: sortedSessions, // Include scores with session names and snippets for debugging
        partial: isPartial, // True if some messages were skipped due to embedding limit
        suggestSpider: messagesSkipped > 10, // Suggest running Spider if many messages were skipped
        debug: {
          query,
          correctedQuery: correctedQuery !== query ? correctedQuery : undefined,
          queryExpansionTimeMs: queryExpansionTimeMs > 0 ? queryExpansionTimeMs : undefined,
          minSimilarity,
          hybridMode,
          keywords: hybridMode ? keywords : [],
          keywordMatchCount: hybridMode ? keywordMatchCount : null,
          messagesWithEmbedding,
          messagesGenerated,
          messagesSkipped, // How many messages couldn't be processed
          maxOnTheFlyEmbeddings: MAX_ON_THE_FLY_EMBEDDINGS,
          reRankingUsed: reRankingSucceeded,
          reRankingTimeMs: reRankingSucceeded ? reRankingTimeMs : undefined,
          candidatesReRanked: reRankingSucceeded ? candidatesReRanked : undefined,
          candidatesFiltered: reRankingSucceeded ? candidatesFiltered : undefined,
        },
      });
    } catch (error) {
      req.logger?.error?.('Semantic search failed:', error);
      return res.status(500).json({
        error: 'Semantic search failed. Please try again.',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
