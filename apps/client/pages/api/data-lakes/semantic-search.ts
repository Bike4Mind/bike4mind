import { Request, Response } from 'express';
import { z } from 'zod';
import { baseApi } from '@server/middlewares/baseApi';
import { DATA_LAKE_QUERY_SCOPES } from '@server/dataLakes/dataLakeScopes';
import { resolveDefaultEmbeddingModel } from '@server/utils/resolveDefaultEmbeddingModel';
import { rateLimit } from '@server/middlewares/rateLimit';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { dataLakeService } from '@bike4mind/services';
import { isSupportedEmbeddingModel } from '@bike4mind/common';
import { resolveRetrievalLakeScope } from '@server/dataLakes/resolveRetrievalLakeScope';
import { runLakeSemanticSearch } from '@server/dataLakes/runLakeSemanticSearch';
import { SEMANTIC_SEARCH_RATE_LIMIT } from '@server/dataLakes/semanticSearchRateLimit';

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
 * The core (budgets, model binding, credit pre-flight, search, audit, settlement) lives in
 * runLakeSemanticSearch, shared with POST /api/v1/data-lakes/{id}/search.
 *
 * Billing: the query embedding is real spend, so a credit pre-flight (per-member cap, then the
 * pool) runs before the embed whenever operational billing is enabled; settlement is
 * recordOperationalUsage, which owns the debit itself. A rejected caller gets a 422 tagged
 * `insufficient_credits` and no ledger row.
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
 *   - latency_ms: number (whole request; `scan.ann_slowest_query_ms` is the ANN share of it)
 *   - scan: coverage accounting. When `scan.truncated` is true a budget stopped the walk, so the
 *     results rank only part of the corpus - do not read an absence of hits as an absence of
 *     content. `scan.budgets` echoes the limits in force so a caller can explain the truncation.
 */

/**
 * snake_case the scan accounting. Used by BOTH the no-lakes short-circuit and the success path so
 * the response shape never varies between them - the RLM tool forwards this JSON verbatim.
 */
/**
 * Snake_case the embedding-mismatch report. Distinct from `scan`: that says how much of the corpus
 * was REACHED, this says whether what was reached could be COMPARED. Shared by both exits so the
 * empty-scope path cannot drift from the success path.
 *
 * MUST STAY IN SYNC with EmbeddingMismatchReport in the services package.
 */
const toMismatchPayload = (report: dataLakeService.EmbeddingMismatchReport) => ({
  excluded_files: {
    count: report.excludedFiles.count,
    models: report.excludedFiles.models,
    estimated_chunks: report.excludedFiles.estimatedChunks,
    sample: report.excludedFiles.sample.map(f => ({
      file_id: f.fileId,
      file_name: f.fileName,
      embedding_model: f.embeddingModel,
    })),
  },
  skipped_chunks: {
    total: report.skippedChunks.total,
    by_reason: {
      unknown_file: report.skippedChunks.byReason.unknownFile,
      model_mismatch: report.skippedChunks.byReason.modelMismatch,
      missing_vector: report.skippedChunks.byReason.missingVector,
      dimension_mismatch: report.skippedChunks.byReason.dimensionMismatch,
    },
  },
  unlabeled: { chunks: report.unlabeled.chunks, files: report.unlabeled.files },
  // Files searched via an ALTERNATE model's own ANN index rather than excluded - see
  // groupFilesByEmbeddingModel/alternateModelAnn.ts. Never implies partial_results on its own.
  alternate_model_served: {
    files: report.alternateModelServed.files,
    models: report.alternateModelServed.models,
  },
  query_embedding_failed: report.queryEmbeddingFailed,
});

/**
 * Flatten the retrieval-unavailable report to the wire shape. Shared by BOTH exits for the same
 * reason as `toScanPayload` and `toMismatchPayload`: the RLM tool forwards this JSON verbatim and its
 * prompt documents the field as always present, so a path that omits it TypeErrors REPL code that
 * reads `retrieval_unavailable.indexing_files`. Flat counts rather than the whole report - a caller
 * needs to know how much is temporarily unsearchable, and the file names are already in `warning`.
 */
const toRetrievalUnavailablePayload = (report: dataLakeService.RetrievalUnavailableReport) => ({
  indexing_files: report.indexing.count,
  // Counted apart from `indexing_files` because waiting does not fix these - see the report type. A
  // caller that adds them together would tell the user to retry and be wrong.
  paused_files: report.paused.count,
  partial: report.partial,
});

/**
 * Flatten the supersession report to the wire shape, same always-present contract as the payloads
 * above. Ids and tiers ride along rather than just a count: the weakest identity tier is a bare file
 * name, so a caller has to be able to tell WHICH member was suppressed and on what evidence.
 */
const toSupersessionPayload = (report: dataLakeService.SupersessionReport) => ({
  collapsed_files: report.count,
  collapsed: report.sample.map(f => ({
    file_id: f.fileId,
    file_name: f.fileName,
    tier: f.tier,
    superseded_by: f.supersededBy,
  })),
  partial: report.partial,
});

const toScanPayload = (scan: dataLakeService.SemanticSearchScanAccounting) => ({
  truncated: scan.truncated,
  file_budget_hit: scan.fileBudgetHit,
  chunk_budget_hit: scan.chunkBudgetHit,
  files_matching: scan.filesMatching,
  files_scoped: scan.filesScoped,
  files_scanned: scan.filesScanned,
  chunks_scanned: scan.chunksScanned,
  chunks_skipped_dimension_mismatch: scan.chunksSkippedDimensionMismatch,
  // Files served by ANN retrieval (Atlas $vectorSearch or self-host OpenSearch, across the
  // primary model and every alternate model queried) instead of the brute-force scan - additive
  // to files_scanned, not a replacement (see SemanticSearchScanAccounting.annFilesQueried).
  // Without these a caller computing coverage from files_scanned alone would undercount an
  // ANN-served file as unsearched.
  ann_files_queried: scan.annFilesQueried,
  ann_hits: scan.annHits,
  ann_models_queried: scan.annModelsQueried,
  // Scoped files per lake. Without it `files_scoped` is a single number over the union and a
  // caller cannot tell a lake that contributed nothing from one that contributed most of the
  // scope - the gap that let a multi-lake search report every lake as searched. The empty-string
  // key holds files attributable to no lake (the caller's own and shared files).
  files_by_lake: scan.filesByLake,
  // The ANN share of latency_ms, so a slow search can be attributed from the response itself
  // rather than from CloudWatch minutes later. The counters above cannot tell a 49s search from a
  // 2s one, and this route runs under a 60s Lambda ceiling - a first production search spent 45.4s
  // of 49.2s somewhere after the query embedding, and this is the field that says whether that
  // somewhere was the ANN query. null when none reached a backend, which is not an instant one.
  ann_slowest_query_ms: scan.annSlowestQueryMs,
  // Per-document cap: whether it actually bound, and the ANN limit that was requested. `cap_pool`
  // is why ann_hits can step by a factor of 3 with the cap on - a wider ask, not a retrieval
  // change - and cap_promotions is the only signal that separates a cap that redistributed slots
  // from one that was enabled and inert.
  cap_promotions: scan.capPromotions,
  cap_pool: scan.candidatePoolK,
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

const handler = baseApi({ requiredScopes: DATA_LAKE_QUERY_SCOPES })
  .use(
    // Rate limit: prevents a caller from spamming the platform's embedding
    // provider key (used for embedding the query).
    rateLimit(SEMANTIC_SEARCH_RATE_LIMIT)
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
      const embedding_model =
        parsed.data.embedding_model ?? (await resolveDefaultEmbeddingModel(req.logger, 'semantic-search'));

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
      const scope = await resolveRetrievalLakeScope(req);

      const outcome = await runLakeSemanticSearch(req, {
        query,
        topK: top_k,
        minScore: min_score,
        tags,
        embeddingModel: embedding_model,
        embeddingModelExplicit: parsed.data.embedding_model !== undefined,
        scope,
        isAborted,
      });

      if (outcome.kind === 'aborted') return res.end();
      if (outcome.kind === 'provider_not_configured') return res.status(500).json({ error: outcome.message });
      if (outcome.kind === 'empty') {
        return res.json({
          results: [],
          total_chunks_searched: 0,
          files_in_scope: 0,
          embedding_model: outcome.embeddingModel,
          latency_ms: Date.now() - t0,
          chunks_scored: 0,
          partial_results: false,
          embedding_mismatch: toMismatchPayload(dataLakeService.emptyEmbeddingMismatchReport()),
          retrieval_unavailable: toRetrievalUnavailablePayload(dataLakeService.emptyRetrievalUnavailableReport()),
          superseded: toSupersessionPayload(dataLakeService.emptySupersessionReport()),
          scan: toScanPayload(dataLakeService.emptyScanAccounting(outcome.budgets)),
        });
      }
      const { search } = outcome;

      // One seam for every reason a search returned less than the whole corpus (embedding-space
      // mismatch, and content withheld because it is mid-(re)index), so a third reason added later
      // reaches this response without another edit here.
      const warning = dataLakeService.describeSearchLimitations(search);

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
        chunks_scored: search.chunksScored,
        // The single flag a caller branches on to know the answer is incomplete because content was
        // WITHHELD - either because it could not be compared (embedding space) or because it could
        // not be served (mid-re-index, #1681). scan.truncated is the separate "did we reach
        // everything" signal, and a supersession collapse is deliberately NOT counted here: nothing
        // was withheld, the corpus was deduplicated. Read `superseded` below for that.
        partial_results: dataLakeService.isPartialSearch(search),
        embedding_mismatch: toMismatchPayload(search.embeddingMismatch),
        retrieval_unavailable: toRetrievalUnavailablePayload(search.retrievalUnavailable),
        superseded: toSupersessionPayload(search.supersession),
        // Spread rather than `warning: warning ?? undefined`, so the key is genuinely absent on a
        // healthy search instead of present-and-undefined.
        ...(warning ? { warning } : {}),
        scan: toScanPayload(search.scan),
      });
    })
  );

export default handler;
