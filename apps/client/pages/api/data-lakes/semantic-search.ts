import { Request, Response } from 'express';
import { z } from 'zod';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import {
  fabFileRepository,
  fabFileChunkRepository,
  apiKeyRepository,
  adminSettingsRepository,
  creditTransactionRepository,
  organizationRepository,
  usageEventRepository,
  userRepository,
} from '@bike4mind/database';
import { apiKeyService, dataLakeService, recordOperationalUsage } from '@bike4mind/services';
import { getProviderFromModel } from '@bike4mind/fab-pipeline';
import {
  ApiKeyType,
  getEmbeddingModelCost,
  ModelBackend,
  OpenAIEmbeddingModel,
  DATA_LAKES,
  getAccessibleDataLakes,
  hasDeveloperUserTag,
  isSupportedEmbeddingModel,
  type SupportedEmbeddingModel,
} from '@bike4mind/common';
import { createTokenizer } from '@bike4mind/utils';
import { getRequestEntitlements } from '@server/entitlements';

/**
 * POST /api/data-lakes/semantic-search
 *
 * Vector-based semantic search across FabFile chunks in the user's accessible
 * data lakes. Embeds the query, cosine-sims against pre-computed chunk vectors
 * (currently text-embedding-ada-002), returns top-K chunks with parent file
 * metadata.
 *
 * Complements the keyword-based `/api/data-lakes/articles?search=...` which
 * matches against fileName + tags + notes only. This endpoint reads the vector
 * field that the fabFileVectorize pipeline already populates per chunk.
 *
 * Auth: session/api-key auth, then scope is the lakes the caller can access per
 * each lake's own declared gate (`requiredUserTag`/`requiredEntitlement` on the
 * static registry). Zero accessible lakes -> empty result set before any
 * embedding cost is incurred. NOTE: deliberately scoped to the STATIC lake
 * registry for now - dynamic (user-created) lakes need the ownership
 * scoping that `queryDataLakeArticles` applies before they can join the search
 * scope here.
 *
 * Body:
 *   - query: string                 (required) - natural-language search query
 *   - top_k: number = 10            - max results to return
 *   - min_score: number = 0.0       - discard results below this cosine score
 *   - tags: string[] = []           - optional tag filter on parent FabFile
 *   - embedding_model?: string      - override embedding model (defaults to ada-002,
 *                                     must be a known SupportedEmbeddingModel)
 *
 * Returns:
 *   - results: Array<{ chunk_id, file_id, file_name, file_tags, chunk_text, score }>
 *   - total_chunks_searched: number
 *   - embedding_model: string
 *   - latency_ms: number
 */

const SemanticSearchInput = z.object({
  query: z.string().min(1).max(4000),
  top_k: z.number().int().min(1).max(100).default(10),
  min_score: z.number().min(-1).max(1).default(0.0),
  tags: z.array(z.string()).default([]),
  // Allowlisted via .refine() against `isSupportedEmbeddingModel` to prevent
  // a caller from forcing a non-existent or unexpectedly-priced model.
  embedding_model: z.string().default(OpenAIEmbeddingModel.TEXT_EMBEDDING_ADA_002).refine(isSupportedEmbeddingModel, {
    message: 'embedding_model must be a known SupportedEmbeddingModel',
  }),
});

const handler = baseApi()
  .use(
    // Rate limit: prevents a caller from spamming the platform's embedding
    // provider key (used for embedding the query).
    rateLimit({
      limit: process.env.NODE_ENV === 'development' ? 100 : 10,
      windowMs: 60 * 1000,
    })
  )
  .post(
    asyncHandler(async (req: Request, res: Response) => {
      const t0 = Date.now();

      const userTags: string[] = req.user.tags ?? [];

      // --- Validate input (safeParse - surfaces errors without leaking schema internals) ---
      const parsed = SemanticSearchInput.safeParse(req.body || {});
      if (!parsed.success) {
        return res.status(400).json({
          error: 'Invalid request body',
          details: parsed.error.flatten(),
        });
      }
      const { query, top_k, min_score, tags, embedding_model } = parsed.data;

      // --- Request cancellation: bail out early if the client disconnects ---
      // Keeps the Lambda from continuing to embed + scan after the caller is
      // already gone. The `close` listener fires on both client-aborted
      // disconnects AND on normal end-of-request, so we filter to the
      // "response not yet sent" case via res.writableEnded. After our
      // long-running steps we check the resulting flag.
      let clientAborted = false;
      req.on('close', () => {
        if (!res.writableEnded) clientAborted = true;
      });
      const isAborted = () => clientAborted;

      // --- Resolve accessible data lakes (this IS the access gate) ---
      // Each lake declares its own `requiredUserTag`/`requiredEntitlement`; the
      // any-of filter below scopes the search to lakes the caller can access.
      // Pass resolved entitlement keys so tag-less entitlement holders (e.g.
      // email-domain grants) are scoped to the same lakes as tag holders. Keys
      // are resolved only in the else branch - admin/developer short-circuit,
      // so resolving up front would cost them a discarded subscription read.
      const accessibleLakes =
        req.user.isAdmin || hasDeveloperUserTag(req.user.tags)
          ? DATA_LAKES
          : getAccessibleDataLakes(userTags, undefined, await getRequestEntitlements(req));

      if (accessibleLakes.length === 0) {
        return res.json({
          results: [],
          total_chunks_searched: 0,
          embedding_model,
          latency_ms: Date.now() - t0,
        });
      }

      const dataLakeTags = accessibleLakes.map(dl => dl.datalakeTag);
      const dataLakeTagPrefixes = accessibleLakes.map(dl => dl.fileTagPrefix);

      // --- Get the embedding-provider API key (OpenAI or VoyageAI) for the requested model ---
      // embedding_model may be a VoyageAI model, so resolve the key for the model's actual
      // provider instead of assuming OpenAI - otherwise a configured VoyageAI key is never
      // used and the search fails despite being set up correctly.
      const dbAdapters = { db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository } };
      const userIdForService = req.user?.id || 'system';
      const embeddingProvider = getProviderFromModel(embedding_model as SupportedEmbeddingModel);
      const embeddingKeyType = embeddingProvider === ModelBackend.VoyageAI ? ApiKeyType.voyageai : ApiKeyType.openai;
      const embeddingApiKey = await apiKeyService.getEffectiveApiKey(
        userIdForService,
        { type: embeddingKeyType },
        dbAdapters
      );

      if (!embeddingApiKey) {
        return res.status(500).json({
          error: `${embeddingProvider} API key not configured. Required for query embedding with model ${embedding_model}.`,
        });
      }

      if (isAborted()) return res.end();

      // --- Delegate to the shared in-process semantic search service ---
      // (Same implementation the chat search_knowledge_base tool uses - single source of
      // truth: embed query -> scope files -> bulk chunk vectors -> cosine rank -> top-K.)
      const search = await dataLakeService.semanticDataLakeSearch(
        {
          userId: req.user.id,
          userGroups: req.user.groups ?? [],
          query,
          tags,
          topK: top_k,
          minScore: min_score,
          embeddingModel: embedding_model as SupportedEmbeddingModel,
          apiKeyTable:
            embeddingProvider === ModelBackend.VoyageAI ? { voyageai: embeddingApiKey } : { openai: embeddingApiKey },
          dataLakeTags,
          dataLakeTagPrefixes,
          logger: req.logger,
        },
        { db: { fabfiles: fabFileRepository, fabfilechunks: fabFileChunkRepository } }
      );

      // Record the query-embedding spend (the embed ran inside the search above).
      // Best-effort: never let a recording failure fail the search response.
      try {
        const user = await userRepository.findById(req.user.id);
        if (user) {
          const organization = user.organizationId ? await organizationRepository.findById(user.organizationId) : null;
          const queryTokens = await createTokenizer({ logger: req.logger }).countTokens(query, embedding_model);
          await recordOperationalUsage(
            {
              requestId: req.user.id,
              user,
              organization,
              feature: 'embedding',
              provider: embeddingProvider,
              model: embedding_model,
              inputTokens: queryTokens,
              costUsd: getEmbeddingModelCost(embedding_model, queryTokens),
              source: 'api',
            },
            {
              db: {
                usageEvents: usageEventRepository,
                adminSettings: adminSettingsRepository,
                creditTransactions: creditTransactionRepository,
                users: userRepository,
                organizations: organizationRepository,
              },
              logger: req.logger,
            }
          );
        }
      } catch (recordErr) {
        req.logger?.warn('[semantic-search] failed to record embedding usage', recordErr);
      }

      if (isAborted()) return res.end();

      return res.json({
        results: search.results.map(r => ({
          chunk_id: r.chunkId,
          file_id: r.fileId,
          file_name: r.fileName,
          file_tags: r.fileTags,
          chunk_text: r.chunkText,
          score: r.score,
        })),
        total_chunks_searched: search.totalChunksSearched,
        files_in_scope: search.filesInScope,
        embedding_model: search.embeddingModel,
        latency_ms: Date.now() - t0,
      });
    })
  );

export default handler;
