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
  isSupportedEmbeddingModel,
  type SupportedEmbeddingModel,
} from '@bike4mind/common';
import { createTokenizer, getSettingsByNames, type ITokenizer } from '@bike4mind/utils';
import type { Logger } from '@bike4mind/observability';
import { resolveRetrievalLakeScope } from '@server/dataLakes/resolveRetrievalLakeScope';

// Reused across requests so the tiktoken encoder is resolved once, not per search.
let sharedTokenizer: ITokenizer | undefined;
function getSharedTokenizer(logger: Logger): ITokenizer {
  if (!sharedTokenizer) sharedTokenizer = createTokenizer({ logger });
  return sharedTokenizer;
}

/**
 * POST /api/data-lakes/semantic-search
 *
 * Vector-based semantic search across FabFile chunks in the user's accessible
 * data lakes. Embeds the query with the model the corpus was vectorized with,
 * cosine-sims against the pre-computed chunk vectors, returns top-K chunks with
 * parent file metadata.
 *
 * Complements the keyword-based `/api/data-lakes/articles?search=...` which
 * matches against fileName + tags + notes only. This endpoint reads the vector
 * field that the fabFileVectorize pipeline already populates per chunk.
 *
 * Auth: session/api-key auth, then scope comes from `resolveRetrievalLakeScope`,
 * which wraps the same `getDynamicDataLakeAccess` the chat `search_knowledge_base`
 * tool uses - so both entry points search the same lakes for the same caller.
 * Dynamic (user-created) lakes are included; their user-controlled tag prefixes
 * ride the SCOPED bucket, matched only within owner/org access, while the static
 * registry's reserved prefixes stay in the OPEN (ownership-bypass) bucket. Zero
 * accessible lakes -> empty result set before any embedding cost is incurred.
 *
 * One deliberate difference from chat: admin/developer callers additionally get
 * the whole static registry (see resolveRetrievalLakeScope), preserving the reach
 * this endpoint has always given them.
 *
 * Unlike the chat tool this route passes no `retrievalFilter` - that filter is
 * session-derived and there is no session here, so a file chat would exclude is
 * still returned. Same lakes, wider file set; revisit if this route ever gains a
 * session context.
 *
 * Body:
 *   - query: string                 (required) - natural-language search query
 *   - top_k: number = 10            - max results to return
 *   - min_score: number = 0.0       - discard results below this cosine score
 *   - tags: string[] = []           - optional tag filter on parent FabFile
 *   - embedding_model?: string      - override embedding model (defaults to the admin's
 *                                     `defaultEmbeddingModel`, which is what the corpus was
 *                                     vectorized with; must be a known SupportedEmbeddingModel)
 *
 * Returns:
 *   - results: Array<{ chunk_id, file_id, file_name, file_tags, chunk_text, score }>
 *   - total_chunks_searched: number
 *   - files_in_scope: number
 *   - embedding_model: string
 *   - latency_ms: number
 *   - scan: coverage accounting. When `scan.truncated` is true a budget stopped the walk, so the
 *     results rank only part of the corpus - do not read an absence of hits as an absence of
 *     content. `scan.budgets` echoes the limits in force so a caller can explain the truncation.
 */

/**
 * snake_case the scan accounting. Used by BOTH the no-lakes short-circuit and the success path so
 * the response shape never varies between them - the RLM tool forwards this JSON verbatim.
 */
const toScanPayload = (scan: dataLakeService.SemanticSearchScanAccounting) => ({
  truncated: scan.truncated,
  file_budget_hit: scan.fileBudgetHit,
  chunk_budget_hit: scan.chunkBudgetHit,
  files_matching: scan.filesMatching,
  files_scoped: scan.filesScoped,
  files_scanned: scan.filesScanned,
  chunks_scanned: scan.chunksScanned,
  chunks_skipped_dimension_mismatch: scan.chunksSkippedDimensionMismatch,
  budgets: { max_files: scan.budgets.maxFiles, max_chunks: scan.budgets.maxChunks },
});

const SemanticSearchInput = z.object({
  query: z.string().min(1).max(4000),
  top_k: z.number().int().min(1).max(100).default(10),
  min_score: z.number().min(-1).max(1).default(0.0),
  tags: z.array(z.string()).default([]),
  // Allowlisted via .refine() against `isSupportedEmbeddingModel` to prevent
  // a caller from forcing a non-existent or unexpectedly-priced model. Optional rather than
  // defaulted: the fallback is the admin's configured model, which zod cannot read here.
  embedding_model: z
    .string()
    .refine(isSupportedEmbeddingModel, { message: 'embedding_model must be a known SupportedEmbeddingModel' })
    .optional(),
});

/**
 * The model the corpus was actually embedded with. The vectorize pipeline
 * (queueHandlers/fabFileChunk) and the chat KB tool both read `defaultEmbeddingModel`, so a
 * query embedded with anything else either matches nothing (the ranker skips vectors of a
 * different dimension) or ranks across two incompatible embedding spaces.
 *
 * Falls back to ada-002 when the setting is unset, names a model we no longer support, or
 * cannot be read. Every fallback warns: the symptom is an empty result set rather than an
 * error, so without a log an admin misconfiguration is indistinguishable from "nothing
 * matched" and lands as a support ticket.
 */
async function resolveDefaultEmbeddingModel(logger: Logger): Promise<SupportedEmbeddingModel> {
  try {
    const configured = await adminSettingsRepository.getSettingsValue('defaultEmbeddingModel');
    if (typeof configured === 'string' && isSupportedEmbeddingModel(configured)) {
      return configured as SupportedEmbeddingModel;
    }
    if (configured !== undefined && configured !== null && configured !== '') {
      logger?.warn(
        `[semantic-search] defaultEmbeddingModel "${String(configured)}" is not a supported embedding model; ` +
          'falling back to ada-002, which will not match a corpus vectorized with another model'
      );
    }
  } catch (err) {
    logger?.warn('[semantic-search] failed to read defaultEmbeddingModel; using ada-002', err);
  }
  return OpenAIEmbeddingModel.TEXT_EMBEDDING_ADA_002;
}

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

      // --- Validate input (safeParse - surfaces errors without leaking schema internals) ---
      const parsed = SemanticSearchInput.safeParse(req.body || {});
      if (!parsed.success) {
        return res.status(400).json({
          error: 'Invalid request body',
          details: parsed.error.flatten(),
        });
      }
      const { query, top_k, min_score, tags } = parsed.data;
      const embedding_model = parsed.data.embedding_model ?? (await resolveDefaultEmbeddingModel(req.logger));

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
      const { dataLakeTags, dataLakeTagPrefixes, scopedTagPrefixes } = await resolveRetrievalLakeScope(req);

      // Every lake contributes exactly one meta-tag, so an empty tag list means zero
      // accessible lakes. Gating on the prefixes instead would be wrong: a caller can
      // legitimately hold only dynamic lakes, whose prefixes are all in the SCOPED bucket.
      if (dataLakeTags.length === 0) {
        const budgets = await dataLakeService.resolveSearchBudgets(
          { adminSettings: adminSettingsRepository },
          req.logger
        );
        return res.json({
          results: [],
          total_chunks_searched: 0,
          files_in_scope: 0,
          embedding_model,
          latency_ms: Date.now() - t0,
          scan: toScanPayload(dataLakeService.emptyScanAccounting(budgets)),
        });
      }

      // --- Get the embedding-provider API key (OpenAI or VoyageAI) for the requested model ---
      // embedding_model may be a VoyageAI model, so resolve the key for the model's actual
      // provider instead of assuming OpenAI - otherwise a configured VoyageAI key is never
      // used and the search fails despite being set up correctly.
      const dbAdapters = { db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository } };
      const userIdForService = req.user?.id || 'system';
      const embeddingProvider = getProviderFromModel(embedding_model as SupportedEmbeddingModel);

      // Ollama (self-host) is keyless: it needs a base URL, resolved via the effective
      // LLM keys, not a stored secret. Other providers resolve a single API key.
      let embeddingApiKeyTable: { openai?: string | null; voyageai?: string | null; ollama?: string | null };
      if (embeddingProvider === ModelBackend.Ollama) {
        const effectiveKeys = await apiKeyService.getEffectiveLLMApiKeys(
          userIdForService,
          { db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository }, getSettingsByNames },
          { logger: req.logger }
        );
        if (!effectiveKeys?.ollama) {
          return res.status(500).json({
            error: `Ollama base URL not configured. Required for query embedding with model ${embedding_model}.`,
          });
        }
        embeddingApiKeyTable = { ollama: effectiveKeys.ollama };
      } else {
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
        embeddingApiKeyTable =
          embeddingProvider === ModelBackend.VoyageAI ? { voyageai: embeddingApiKey } : { openai: embeddingApiKey };
      }

      if (isAborted()) return res.end();

      // --- Delegate to the shared in-process semantic search service ---
      // (Same implementation AND the same lake-scope resolution the chat search_knowledge_base
      // tool uses: embed query -> scope files -> bulk chunk vectors -> cosine rank -> top-K.)
      const search = await dataLakeService.semanticDataLakeSearch(
        {
          userId: req.user.id,
          userGroups: req.user.groups ?? [],
          query,
          tags,
          topK: top_k,
          minScore: min_score,
          embeddingModel: embedding_model as SupportedEmbeddingModel,
          apiKeyTable: embeddingApiKeyTable,
          dataLakeTags,
          dataLakeTagPrefixes,
          scopedTagPrefixes, // dynamic-lake prefixes - matched only within owner/org access
          budgets: await dataLakeService.resolveSearchBudgets({ adminSettings: adminSettingsRepository }, req.logger),
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
          const queryTokens = await getSharedTokenizer(req.logger).countTokens(query, embedding_model);
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
        scan: toScanPayload(search.scan),
      });
    })
  );

export default handler;
