import {
  DATA_LAKE_SEARCH_MAX_CHUNKS_DEFAULT,
  DATA_LAKE_SEARCH_MAX_FILES_DEFAULT,
  defaultEmbeddingModelForEnv,
  FabFileChunkVector,
  IFabFileChunkRepository,
  IFabFileDocument,
  IFabFileRepository,
  SupportedEmbeddingModel,
} from '@bike4mind/common';
import {
  computeCosineSimilarity,
  EmbeddingFactory,
  getProviderFromModel,
  resolveEmbeddingConfig,
} from '@bike4mind/utils';
import { filterRetrievalExcluded, type RetrievalExclusionOptions } from '@bike4mind/utils/retrievalExclusion';
import { Logger } from '@bike4mind/observability';
import { supportsAtlasVectorSearch, selfHostOpenSearchEnabled } from '@bike4mind/db-core';
import {
  classifyLoadedChunk,
  createEmbeddingMismatchAccumulator,
  emptyEmbeddingMismatchReport,
  groupFilesByEmbeddingModel,
  isForeignEmbeddingModel,
  type EmbeddingMismatchAccumulator,
  type EmbeddingMismatchReport,
} from './embeddingMismatch';
import { BoundedTopK } from './boundedTopK';
import { partitionByVectorSearchReadiness } from './vectorSearchEligibility';
import { atlasVectorSearch, type AtlasVectorSearchAdapters } from './atlasVectorSearch';
import { openSearchVectorSearch, type OpenSearchVectorSearchAdapters } from './openSearchVectorSearch';
import { planAlternateAnnModels, runAlternateModelAnn, type AlternateAnnOutcome } from './alternateModelAnn';
import type { AnnVectorSearchResult } from './annVectorSearch';

/**
 * Shared vector/semantic search over FabFile chunks in a user's accessible data lakes.
 *
 * Extracted from the semantic-search endpoint so it and the chat KB tool run ONE
 * implementation in-process. (The RLM tools reach the same code, but over an HTTP loopback
 * to the endpoint rather than in-process.) Modeled on the dependency-injected
 * getRelevantMementos pattern: pure, adapter-injected, never imports @bike4mind/database.
 * Reuses EmbeddingFactory (query embed) + computeCosineSimilarity (ranking) + the chunk
 * vectors the fabFileVectorize pipeline already populates.
 *
 * Ranking is a BOUNDED STREAMING scan, not a bulk load: chunk vectors are walked in keyset pages,
 * scored into a fixed-size top-K, then dropped, so the vector phase costs O(topK + one page)
 * instead of O(corpus) - which is where the memory actually went. When a budget stops the walk
 * short, the result says so (see `scan`) instead of passing a partial corpus off as complete.
 *
 * The FILE phase is bounded by `maxFiles`, not by a page: the scope is accumulated across pages
 * before ranking, so it holds up to that many content-projected FabFile documents. It also uses
 * skip pagination, so the last page's sort grows with the offset - which is why `maxFiles` defaults
 * to a few pages rather than a huge number. Keyset-paginating files (and streaming them into the
 * scan) is the next step if lakes outgrow that.
 *
 * Data-lake SCOPING is the caller's concern (passed as dataLakeTags + the two prefix
 * buckets). Both the endpoint and the chat tool now compute it from
 * getDynamicDataLakeAccess, so this stays a single retrieval primitive fed by a single
 * access resolver.
 */

/** Files scoped per fabfiles.search page. Page 1 alone reproduces the pre-pagination query. */
const DEFAULT_FILE_PAGE_SIZE = 2000;
/** Files per chunk query - bounds the `$in` breadth without making pages tiny. */
const DEFAULT_FILE_GROUP_SIZE = 200;
/**
 * Target float64 payload per chunk page. Derived from the query's dimension rather than a fixed
 * row count because supported models span 1024-3072 dims, so a fixed count would swing peak
 * memory 3x. ~1MB of vectors per page also stays well under DocumentDB's 32MB sort limit on a
 * planner that cannot merge the per-file scans and falls back to a bounded top-N sort.
 */
const CHUNK_PAGE_TARGET_FLOATS = 1_000_000;
const MIN_CHUNK_PAGE_SIZE = 100;
const MAX_CHUNK_PAGE_SIZE = 1000;

export interface SemanticChunkResult {
  chunkId: string;
  fileId: string;
  fileName: string;
  fileTags: string[];
  chunkText: string;
  score: number;
}

/** Tuning + hard limits. All optional; the module defaults apply when omitted. */
export interface SemanticSearchBudgets {
  /** Hard cap on files scoped for scanning. Default DATA_LAKE_SEARCH_MAX_FILES_DEFAULT. */
  maxFiles?: number;
  /** Hard cap on chunk vectors fetched and scored. Default DATA_LAKE_SEARCH_MAX_CHUNKS_DEFAULT. */
  maxChunks?: number;
  /** fabfiles.search page size while paginating the scope. Default 2000. */
  filePageSize?: number;
  /** Files per chunk query. Default 200. */
  fileGroupSize?: number;
  /** Rows per chunk page. Default derived from the query embedding dimension. */
  chunkPageSize?: number;
}

/**
 * Scan accounting - lets a caller tell "searched the whole corpus" from "searched a budgeted
 * prefix of it", which the pre-existing counters could not express.
 *
 * Invariant: filesScanned <= filesScoped <= filesMatching.
 */
export interface SemanticSearchScanAccounting {
  /**
   * A budget stopped the walk, so `results` rank an INCOMPLETE corpus. This is the field to
   * branch on. Deliberately NOT `filesScanned < filesMatching`: retrieval exclusion and
   * unvectorized files make those differ on a fully-scanned lake, and conflating the two
   * would fire on healthy corpora and make the signal worthless.
   */
  truncated: boolean;
  /** maxFiles stopped the scope pagination: whole files were never looked at. */
  fileBudgetHit: boolean;
  /** maxChunks stopped the chunk walk: the tail of the file order contributed nothing. */
  chunkBudgetHit: boolean;
  /** Files matching the scope in the DB, before any budget or retrieval exclusion. */
  filesMatching: number;
  /** Files handed to the ranker: post-budget, post-retrieval-exclusion. */
  filesScoped: number;
  /**
   * Files a chunk query was actually issued for. When `chunkBudgetHit` is true the last group
   * queried may still be only partly covered, so treat this as an upper bound on coverage -
   * `truncated` is the completeness signal.
   */
  filesScanned: number;
  /** Vector-bearing chunks fetched and scored, including dimension mismatches. */
  chunksScanned: number;
  /** Of those, skipped because their width differs from the query's (embedding model changed). */
  chunksSkippedDimensionMismatch: number;
  /**
   * Files served by ANN retrieval (Atlas `$vectorSearch` or self-host OpenSearch), across the
   * query's own model AND every alternate model that got its own ANN query (see
   * alternateModelAnn.ts), instead of the brute-force scan. Additive to `filesScanned`, not a
   * replacement for it - an ann-served file was never handed to the scan path at all, so
   * `filesScanned + annFilesQueried` is the files actually searched by either route (still <=
   * `filesScoped`; ineligible/not-yet-ready files may be searched by neither if a budget stopped
   * the scan first).
   */
  annFilesQueried: number;
  /** Chunk hits returned by ANN retrieval across all ann-queried files and models, before minScore/scope filtering. */
  annHits: number;
  /**
   * Distinct embedding models an ANN query was actually issued under this search: 0 when ANN
   * never ran, 1 for a healthy single-model lake, up to `1 + MAX_ALTERNATE_ANN_MODELS`. Without
   * this, `annFilesQueried` alone cannot distinguish "one model served 10 files" from "three
   * models served 10" - the distinction this ticket's cutover introduces, and the number an
   * operator needs to see cap pressure.
   */
  annModelsQueried: number;
  /** Budgets in force, echoed so a caller can explain a truncation without guessing. */
  budgets: { maxFiles: number; maxChunks: number };
}

export interface SemanticDataLakeSearchResult {
  results: SemanticChunkResult[];
  /** Same value as `scan.chunksScanned`; retained for existing consumers. */
  totalChunksSearched: number;
  /** Loaded chunks actually cosine-scored. */
  chunksScored: number;
  /**
   * What could not be COMPARED, as distinct from what was not REACHED. `scan.truncated` answers
   * "did we look at everything"; this answers "was what we looked at in the query's embedding
   * space". A lake can be fully scanned and still return a partial answer.
   */
  embeddingMismatch: EmbeddingMismatchReport;
  /** Same value as `scan.filesScoped`; retained for existing consumers. */
  filesInScope: number;
  embeddingModel: string;
  scan: SemanticSearchScanAccounting;
  /**
   * Every alternate embedding model this search actually ran a query embed under (successfully),
   * in `plan.selected` order (the embeds run concurrently, but `Promise.all` preserves input order
   * in its output regardless of completion timing) - a caller must bill a usage event for each of these IN ADDITION TO the primary
   * `embeddingModel`, regardless of whether that model's ANN query then found any hits. See
   * knowledgeBaseSearch/index.ts and apps/client/pages/api/data-lakes/semantic-search.ts.
   */
  alternateModelsEmbedded: string[];
}

export interface SemanticDataLakeSearchParams {
  userId: string;
  /** User's groups for org-level file sharing (forwarded to fabfiles.search). */
  userGroups?: string[];
  /** Natural-language query - embedded and cosine-matched against chunk vectors. */
  query: string;
  /** Optional content-tag filter narrowing the file set (e.g. ['acme:type:product-spec']). */
  tags?: string[];
  topK?: number;
  minScore?: number;
  embeddingModel: SupportedEmbeddingModel;
  apiKeyTable: { openai?: string | null; voyageai?: string | null; ollama?: string | null } | null | undefined;
  /** datalake:* meta-tags for the user's accessible lakes (caller-computed). */
  dataLakeTags: string[];
  /** OPEN static-registry content-tag prefixes (e.g. 'opti:') - ownership-bypass by design. */
  dataLakeTagPrefixes: string[];
  /** SCOPED dynamic-lake prefixes - matched only within owner/org access (caller-computed). */
  scopedTagPrefixes?: string[];
  /** Scan limits + paging tuning. Omit for the defaults; callers may source these from settings. */
  budgets?: SemanticSearchBudgets;
  /**
   * Generic retrieval-exclusion filter forwarded to the scoped file set - drop files whose name
   * begins with a marker (case-insensitive, word-boundary) and/or unvectorized files, before any
   * chunk vectors are loaded or ranked. Caller-driven so the shared primitive (also backing
   * the data-lake semantic-search endpoint) stays un-regressed when omitted. See
   * @bike4mind/utils/retrievalExclusion.
   */
  retrievalFilter?: RetrievalExclusionOptions;
  /**
   * Server-side kill-switch for ANN retrieval - both the Atlas `$vectorSearch` cutover and the
   * self-host OpenSearch path share this one flag (admin setting `EnableDataLakeVectorSearch`) -
   * the caller reads it, not this module, matching how `apiKeyTable`/`budgets` are already
   * resolved by the caller and passed in. Off by default (undefined/false): every existing
   * caller that omits this keeps today's scan-only behavior byte-for-byte. Even when true, the
   * ann path only ever engages on a backend that's actually ready for `embeddingModel` right
   * now (a queryable Atlas index, or self-host OpenSearch enabled) - see rankChunksForFiles.
   */
  vectorSearchEnabled?: boolean;
  logger?: Logger;
}

/** Optional Atlas-cutover methods, on top of the scan path's required ones. Optional so every existing adapter/mock that predates the cutover keeps compiling unchanged. */
type FabFileChunksAdapter = Pick<IFabFileChunkRepository, 'findVectorsByFabFileIds'> &
  Partial<Pick<IFabFileChunkRepository, 'vectorSearch' | 'getAtlasIndexStatus'>>;

export interface SemanticDataLakeSearchAdapters {
  db: {
    fabfiles: Pick<IFabFileRepository, 'search'>;
    fabfilechunks: FabFileChunksAdapter;
  };
  /** Self-host OpenSearch retrieval, undefined elsewhere - a separate cluster, not a Mongo repo method. */
  vectorIndex?: OpenSearchVectorSearchAdapters;
}

/** Shape both entrypoints need from a scoped file's metadata. */
interface RankableFile {
  fileName: string;
  fileTags: string[];
  /**
   * The only record of which embedding space a file's chunks live in - chunks carry no model of
   * their own. Width alone cannot separate ada-002 from text-embedding-3-small (both 1536), so
   * this is what mismatch detection reads.
   */
  embeddingModel?: string | null;
  vectorizedChunkCount?: number;
  /** ANN readiness signal, shared by the Atlas and self-host OpenSearch paths - see vectorSearchEligibility.ts. */
  chunkEmbeddingModelStampedAt?: Date | string | null;
}

/**
 * Total order: score desc, then chunkId. The explicit tiebreaker matters because chunks now
 * arrive page by page - leaving equal scores to arrival order would make the output depend on
 * how the corpus happened to be partitioned.
 */
function compareByScore(a: SemanticChunkResult, b: SemanticChunkResult): number {
  if (b.score !== a.score) return b.score - a.score;
  return a.chunkId < b.chunkId ? -1 : a.chunkId > b.chunkId ? 1 : 0;
}

/**
 * `??` only replaces null/undefined, so a caller-supplied 0 or negative would flow straight into
 * the page-ceiling arithmetic and make it Infinity. Clamp every budget to at least 1 here, once,
 * rather than defending against it at each use.
 */
function resolveBudgets(budgets: SemanticSearchBudgets | undefined) {
  const atLeastOne = (value: number | undefined, fallback: number) =>
    Math.max(1, Math.floor(value ?? fallback) || fallback);
  return {
    maxFiles: atLeastOne(budgets?.maxFiles, DATA_LAKE_SEARCH_MAX_FILES_DEFAULT),
    maxChunks: atLeastOne(budgets?.maxChunks, DATA_LAKE_SEARCH_MAX_CHUNKS_DEFAULT),
    filePageSize: atLeastOne(budgets?.filePageSize, DEFAULT_FILE_PAGE_SIZE),
    fileGroupSize: atLeastOne(budgets?.fileGroupSize, DEFAULT_FILE_GROUP_SIZE),
    // Undefined stays undefined so the dimension-derived default still applies downstream.
    chunkPageSize: budgets?.chunkPageSize === undefined ? undefined : atLeastOne(budgets.chunkPageSize, 1),
  };
}

type ResolvedBudgets = ReturnType<typeof resolveBudgets>;

/**
 * Zeroed accounting for a search that never ran (no scope, blank query). Exported so callers that
 * short-circuit before reaching the service still return the same `scan` shape - a consumer should
 * never have to handle `scan` being absent on some responses.
 */
export function emptyScanAccounting(budgets?: SemanticSearchBudgets): SemanticSearchScanAccounting {
  const resolved = resolveBudgets(budgets);
  return {
    truncated: false,
    fileBudgetHit: false,
    chunkBudgetHit: false,
    filesMatching: 0,
    filesScoped: 0,
    filesScanned: 0,
    chunksScanned: 0,
    chunksSkippedDimensionMismatch: 0,
    annFilesQueried: 0,
    annHits: 0,
    annModelsQueried: 0,
    budgets: { maxFiles: resolved.maxFiles, maxChunks: resolved.maxChunks },
  };
}

function emptyResult(
  embeddingModel: string,
  budgets: ResolvedBudgets,
  overrides: Partial<SemanticSearchScanAccounting> = {}
): SemanticDataLakeSearchResult {
  return {
    results: [],
    totalChunksSearched: 0,
    filesInScope: 0,
    chunksScored: 0,
    embeddingModel,
    embeddingMismatch: emptyEmbeddingMismatchReport(),
    scan: { ...emptyScanAccounting(budgets), ...overrides },
    alternateModelsEmbedded: [],
  };
}

/**
 * Walk the scoped files' chunk vectors in keyset pages, cosine-score them into a fixed-size
 * top-K, and report what was covered. Only one page of vectors is resident at a time, so peak
 * memory is independent of corpus size.
 */
async function scanAndRank(args: {
  fileIds: string[];
  fileById: Map<string, RankableFile>;
  queryEmbedding: number[];
  topK: number;
  minScore: number;
  fileGroupSize: number;
  chunkPageSize: number;
  maxChunks: number;
  queryModel: string;
  mismatch: EmbeddingMismatchAccumulator;
  fabfilechunks: Pick<IFabFileChunkRepository, 'findVectorsByFabFileIds'>;
}): Promise<{
  results: SemanticChunkResult[];
  chunksScanned: number;
  chunksScored: number;
  chunksSkippedDimensionMismatch: number;
  filesScanned: number;
  chunkBudgetHit: boolean;
}> {
  const { fileIds, fileById, queryEmbedding, topK, minScore, fileGroupSize, chunkPageSize, maxChunks } = args;
  const { queryModel, mismatch } = args;
  const queryDim = queryEmbedding.length;
  const ranked = new BoundedTopK<SemanticChunkResult>(topK, compareByScore);

  let chunksScanned = 0;
  let chunksScored = 0;
  let filesScanned = 0;
  let chunkBudgetHit = false;

  // Every page consumes at least one row, so this bounds the inner loop even if a page somehow
  // failed to advance the cursor. Paired with the strict-increase check below, which throws.
  const maxPagesPerGroup = Math.ceil(maxChunks / chunkPageSize) + 1;

  groups: for (let start = 0; start < fileIds.length; start += fileGroupSize) {
    if (maxChunks - chunksScanned <= 0) {
      chunkBudgetHit = true;
      break;
    }
    const group = fileIds.slice(start, start + fileGroupSize);
    filesScanned += group.length;

    let cursor: string | undefined;
    for (let page = 0; page < maxPagesPerGroup; page++) {
      const remaining = maxChunks - chunksScanned;
      if (remaining <= 0) {
        chunkBudgetHit = true;
        break groups;
      }
      // Consume at most `want`, but ask for one extra row to learn whether more exist. Without
      // the probe, a corpus that exactly fills the budget is indistinguishable from one that
      // overflows it and we would report a truncation that never happened.
      const want = Math.min(chunkPageSize, remaining);
      const rows = await args.fabfilechunks.findVectorsByFabFileIds(group, {
        limit: want + 1,
        afterChunkId: cursor,
      });
      if (rows.length === 0) break;

      const moreExist = rows.length > want;
      // The probe row is beyond the budget: it must not be scored or counted, or it could enter
      // the top-K and make the result depend on where the page boundary fell.
      const usable = moreExist ? rows.slice(0, want) : rows;

      for (const chunk of usable as FabFileChunkVector[]) {
        chunksScanned++;
        // Resolve the parent first: it carries the embedding model, and an orphan chunk cannot be
        // attributed to any model. Width alone cannot separate two 1536-dim models, so the
        // classifier reads the recorded label too and reports WHY a chunk was withheld.
        const file = fileById.get(chunk.fabFileId);
        if (!file) {
          mismatch.skip('unknownFile');
          continue;
        }
        const skipReason = classifyLoadedChunk({ vector: chunk.vector, queryDim, parentFile: file, queryModel });
        // The vector check is redundant with the classifier's missingVector case; it is here so
        // the type narrows without an assertion.
        if (skipReason || !chunk.vector) {
          mismatch.skip(skipReason ?? 'missingVector');
          continue;
        }
        chunksScored++;
        mismatch.scored(file, chunk.fabFileId);
        const score = computeCosineSimilarity(queryEmbedding, chunk.vector);
        // A zero-magnitude vector makes cosine NaN, and NaN fails every comparison: it would slip
        // past `score < minScore` and, because it also fails the top-K reject test, sort ahead of
        // every real hit.
        if (!Number.isFinite(score)) continue;
        if (score < minScore) continue;
        ranked.offer({
          chunkId: chunk.id,
          fileId: chunk.fabFileId,
          fileName: file.fileName,
          fileTags: file.fileTags,
          chunkText: chunk.text ?? '',
          score,
        });
      }

      const nextCursor = usable[usable.length - 1]?.id;
      if (nextCursor === undefined || (cursor !== undefined && nextCursor <= cursor)) {
        throw new Error('[semanticSearch] chunk cursor did not advance - refusing to page forever');
      }
      cursor = nextCursor;

      if (!moreExist) break; // short page: this group is drained
      if (want === remaining) {
        chunkBudgetHit = true;
        break groups;
      }
    }
  }

  return {
    results: ranked.drain(),
    chunksScanned,
    chunksScored,
    // Kept for the scan block's own accounting; per-reason detail lives in the report.
    chunksSkippedDimensionMismatch: mismatch.report().skippedChunks.byReason.dimensionMismatch,
    filesScanned,
    chunkBudgetHit,
  };
}

/**
 * Page fabfiles.search up to the file budget. A lake that fits in one page costs exactly one
 * query as before; a larger one is no longer silently cut off at the first page.
 */
async function collectScopedFiles(args: {
  // The repository OBJECT, not a detached `search` reference: FabFileRepository.search calls
  // this.executeSearch, so passing the method alone unbinds `this` and blows up at runtime.
  fabfiles: Pick<IFabFileRepository, 'search'>;
  userId: string;
  userGroups: string[];
  tags: string[];
  dataLakeTags: string[];
  dataLakeTagPrefixes: string[];
  scopedTagPrefixes: string[];
  retrievalFilter: RetrievalExclusionOptions;
  maxFiles: number;
  filePageSize: number;
}): Promise<{ files: IFabFileDocument[]; filesMatching: number; fileBudgetHit: boolean }> {
  const files: IFabFileDocument[] = [];
  let filesMatching = 0;
  let fileBudgetHit = false;

  // The page size must stay CONSTANT across the walk: the query builder derives skip as
  // (page - 1) * limit, so shrinking the limit to fit the remaining budget would move the offset
  // under us - re-reading rows we already have and never reaching the tail. Over-fetch to the
  // page boundary instead and trim to the budget at the end.
  // Clamped to the budget so a small budget also means a small query: without this, lowering the
  // max-files setting to cut latency would still fetch (and sort) a full page before discarding
  // most of it. Computed once so it stays constant, per the skip arithmetic above.
  const pageSize = Math.max(1, Math.min(args.filePageSize, args.maxFiles));
  // A page always consumes pageSize rows, so this bounds the walk even if an adapter kept
  // reporting hasMore forever.
  const maxPages = Math.ceil(args.maxFiles / pageSize) + 1;

  let exhaustedPageCeiling = true;
  for (let page = 1; page <= maxPages; page++) {
    const result = await args.fabfiles.search(
      args.userId,
      '', // no text query - pure data-lake browse; relevance comes from vector cosine below
      { tags: args.tags, shared: false },
      { page, limit: pageSize },
      { by: 'fileName', direction: 'asc' },
      {
        textSearch: false,
        includeShared: true,
        userGroups: args.userGroups,
        dataLakeTags: args.dataLakeTags,
        dataLakeTagPrefixes: args.dataLakeTagPrefixes,
        scopedTagPrefixes: args.scopedTagPrefixes,
        excludeContent: true,
        // fileName is not unique, so walking more than one page needs the _id tiebreaker or a
        // file can fall between pages - the same silent loss this pagination exists to fix.
        stableSort: true,
        // Retrieval exclusion (caller-driven) - best-effort DB pre-filter; the authoritative
        // in-memory pass below guarantees excluded files are dropped before any chunk load.
        ...args.retrievalFilter,
      }
    );
    // `total` is the pre-budget match count. Fall back to what we hold if an adapter omits it.
    if (page === 1) filesMatching = result.total ?? result.data.length;
    files.push(...result.data);
    if (files.length >= args.maxFiles) {
      // Only a truncation if something is actually left over - a corpus that lands exactly on the
      // budget with nothing beyond it was scanned in full.
      fileBudgetHit = files.length > args.maxFiles || result.hasMore;
      exhaustedPageCeiling = false;
      break;
    }
    if (!result.hasMore) {
      exhaustedPageCeiling = false;
      break;
    }
  }
  // Falling out of the loop means an adapter kept reporting hasMore past the ceiling, so files
  // were left unread. Report it rather than returning a silently short scope.
  if (exhaustedPageCeiling) fileBudgetHit = true;

  return { files: files.slice(0, args.maxFiles), filesMatching, fileBudgetHit };
}

/**
 * Shared ranking core: embed the query, stream the scoped files' chunk vectors, cosine-rank
 * within a bounded top-K, and shape the result. File-source-agnostic - the two entrypoints
 * below differ ONLY in how they resolve { fileIds, fileById }, so the embedding/provider
 * handling can never drift between them.
 */
async function rankChunksForFiles(args: {
  query: string;
  fileIds: string[];
  fileById: Map<string, RankableFile>;
  topK: number;
  minScore: number;
  embeddingModel: SupportedEmbeddingModel;
  apiKeyTable: SemanticDataLakeSearchParams['apiKeyTable'];
  budgets: ResolvedBudgets;
  filesMatching: number;
  fileBudgetHit: boolean;
  vectorSearchEnabled: boolean;
  logger?: Logger;
  fabfilechunks: FabFileChunksAdapter;
  vectorIndex?: OpenSearchVectorSearchAdapters;
}): Promise<SemanticDataLakeSearchResult> {
  const { query, fileIds, fileById, topK, minScore, embeddingModel, apiKeyTable, budgets, logger } = args;

  // --- Embed the query (reuse EmbeddingFactory; pick the provider the model needs) ---
  const provider = getProviderFromModel(embeddingModel);
  const { config: embeddingConfig, missing } = resolveEmbeddingConfig(provider, apiKeyTable);
  if (missing) {
    throw new Error(
      missing === 'ollama'
        ? 'Ollama base URL required for semantic search but not found.'
        : `${missing === 'openai' ? 'OpenAI' : 'VoyageAI'} API key required for semantic search but not found.`
    );
  }
  const embeddingService = new EmbeddingFactory(embeddingConfig).createEmbeddingService(embeddingModel);
  const queryEmbedding = await embeddingService.generateEmbedding(query);

  const chunkPageSize =
    budgets.chunkPageSize ??
    Math.min(
      MAX_CHUNK_PAGE_SIZE,
      Math.max(MIN_CHUNK_PAGE_SIZE, Math.floor(CHUNK_PAGE_TARGET_FLOATS / Math.max(1, queryEmbedding.length)))
    );

  // Withhold files whose recorded model puts their vectors in another embedding space, BEFORE the
  // scan: foreign vectors then never enter a page and never spend the chunk budget, so a large
  // off-model file cannot crowd out chunks that could have matched.
  const scopedFiles = fileIds.map(id => {
    const file = fileById.get(id);
    return {
      id,
      fileName: file?.fileName,
      embeddingModel: file?.embeddingModel,
      vectorizedChunkCount: file?.vectorizedChunkCount,
      chunkEmbeddingModelStampedAt: file?.chunkEmbeddingModelStampedAt,
    };
  });
  const { primary: rankable, alternates } = groupFilesByEmbeddingModel(scopedFiles, embeddingModel);
  // Foreign-model files no path has served (yet). Filtering `scopedFiles` (rather than
  // concatenating the grouper's alternate buckets) preserves scope order, so `excludedFiles.sample`
  // stays byte-identical to before this cutover on any lake with no served alternates. `served` is
  // populated once the alternate-model ANN phase below runs; every earlier return passes an empty
  // set, reproducing today's `foreign` list exactly.
  const excludedForeignFiles = (served: ReadonlySet<string>) =>
    scopedFiles.filter(f => isForeignEmbeddingModel(f.embeddingModel, embeddingModel) && !served.has(f.id));

  // An empty query embedding would make every chunk look like a width mismatch and return nothing.
  // Report the real cause rather than ranking against a meaningless vector, and do not throw: a
  // transient provider hiccup should not turn a search into a 500.
  if (queryEmbedding.length === 0) {
    logger?.warn?.('[semanticSearch] query embedding came back empty, nothing can be ranked', {
      queryEmbeddingModel: embeddingModel,
      filesInScope: fileIds.length,
    });
    const mismatch = createEmbeddingMismatchAccumulator(excludedForeignFiles(new Set()), embeddingModel);
    mismatch.queryEmbeddingFailed();
    return {
      ...emptyResult(embeddingModel, budgets, { filesMatching: args.filesMatching, filesScoped: fileIds.length }),
      embeddingMismatch: mismatch.report(),
    };
  }

  // Split same-model files into ANN-eligible and scan-only BEFORE the scan runs, so an
  // ann-served file is never handed to scanAndRank and never spends its chunk budget - per-file
  // subset selection, not all-or-nothing. Every gate below defaults closed: the ann path only
  // engages when the caller opted in AND the backend/index are actually ready right now: a
  // disabled/DocumentDB/not-yet-queryable deployment scans every rankable file exactly as it did
  // before this cutover existed.
  let annEligible: typeof rankable = [];
  let scanEligible = rankable;
  const canUseAtlas =
    args.vectorSearchEnabled &&
    supportsAtlasVectorSearch() &&
    !!args.fabfilechunks.vectorSearch &&
    !!args.fabfilechunks.getAtlasIndexStatus;
  // Atlas and self-host OpenSearch are mutually exclusive: getVectorBackend() resolves to exactly
  // one VectorBackend per deployment, so this is an if/else-if documenting that invariant, not two
  // independent guards that happen never to both fire.
  const canUseOpenSearch =
    !canUseAtlas && args.vectorSearchEnabled && selfHostOpenSearchEnabled() && !!args.vectorIndex;

  if (canUseAtlas) {
    const indexStatus = await args.fabfilechunks.getAtlasIndexStatus!(embeddingModel);
    if (indexStatus?.queryable) {
      const split = partitionByVectorSearchReadiness(rankable, new Date());
      annEligible = split.annReady;
      scanEligible = split.scanOnly;
    }
  } else if (canUseOpenSearch) {
    // No mongot-style indexing-lag concept to check here - the readiness stamp still applies
    // (same-model chunks must be fully vectorized+stamped), but "is it actually in the index yet"
    // is instead covered below by the zero-raw-hits rebucket, same as Atlas's missedFiles case.
    const split = partitionByVectorSearchReadiness(rankable, new Date());
    annEligible = split.annReady;
    scanEligible = split.scanOnly;
  }

  // Shared backend seam for the primary model AND every alternate model - this module never
  // learns that Atlas or OpenSearch exist beyond this one closure.
  const runAnn = (a: { fileIds: string[]; queryVector: number[]; model: string }): Promise<AnnVectorSearchResult> =>
    canUseAtlas
      ? atlasVectorSearch({
          ...a,
          fileById,
          limit: topK,
          minScore,
          adapters: args.fabfilechunks as AtlasVectorSearchAdapters,
        })
      : openSearchVectorSearch({ ...a, fileById, limit: topK, minScore, adapters: args.vectorIndex! });

  let annResult: AnnVectorSearchResult = {
    results: [],
    hitsReturned: 0,
    hitsSkippedUnknownFile: 0,
    filesWithHits: new Set(),
  };
  // Set on a primary-model ANN failure so the alternate-model phase below is skipped entirely -
  // an outage that broke the primary model's query almost certainly breaks every other model on
  // the same backend/connection, so there is no point spending alternate-model embeds against it.
  let primaryAnnFailed = false;
  const primaryAnnQueried = annEligible.length > 0;
  if (annEligible.length > 0) {
    try {
      annResult = await runAnn({
        fileIds: annEligible.map(f => f.id),
        queryVector: queryEmbedding,
        model: embeddingModel,
      });
    } catch (error) {
      // A broken ANN index (transient outage, IAM regression, quota exhaustion, unreachable
      // self-host cluster) must degrade to the scan path, not surface as a 500 - the whole point
      // of the per-file split is that scanAndRank can always cover any file the ann path can't
      // serve right now.
      logger?.warn?.(
        '[semanticSearch] ANN vector search failed, falling back to scan for its files and skipping the alternate-model phase',
        {
          embeddingModel,
          backend: canUseAtlas ? 'atlas' : 'opensearch',
          fileCount: annEligible.length,
          error: error instanceof Error ? error.message : String(error),
        }
      );
      scanEligible = [...scanEligible, ...annEligible];
      annEligible = [];
      primaryAnnFailed = true;
    }

    // A queryable index does not guarantee a given file's chunks are actually IN it yet. On
    // Atlas: mongot's indexing lag can exceed VECTOR_SEARCH_READY_LAG_MS during a bulk backfill,
    // or a re-embed mid-file can label chunks under the wrong model so mongot never indexes
    // them. On self-host OpenSearch: the file's chunks may simply predate the feature being
    // enabled (see selfHostSearchIndex.ts - there is no backfill). Either way the file returns
    // zero raw hits (not "nothing scored well", since both backends rank by similarity before
    // minScore is applied) and, with no scan fallback, would silently contribute zero results.
    // Rebucket per file rather than all-or-nothing, so one un-indexed file in a batch does not
    // cost the rest their ANN path.
    const missedFiles = annEligible.filter(f => !annResult.filesWithHits.has(f.id));
    if (missedFiles.length > 0) {
      logger?.warn?.('[semanticSearch] ANN vector search returned no hits for ready files, scanning them instead', {
        embeddingModel,
        backend: canUseAtlas ? 'atlas' : 'opensearch',
        fileCount: missedFiles.length,
      });
      scanEligible = [...scanEligible, ...missedFiles];
      annEligible = annEligible.filter(f => annResult.filesWithHits.has(f.id));
    }
  }

  // Multi-model ANN cutover: give every OTHER embedding model actually present in the lake its
  // own query (re-embedded under that model) against its own ANN index, instead of dropping those
  // files outright. Gated on the same backend capability as the primary model, and skipped
  // entirely when the primary model's own ANN call just failed (see `primaryAnnFailed` above).
  let outcomes: AlternateAnnOutcome[] = [];
  if ((canUseAtlas || canUseOpenSearch) && !primaryAnnFailed) {
    const isModelQueryable = canUseAtlas
      ? async (m: string) => !!(await args.fabfilechunks.getAtlasIndexStatus!(m))?.queryable
      : // Self-host has no per-model status port. openSearchChunkAdapter already fails closed on
        // an unregistered model or a missing index (returns [] -> filesMissed, not a throw), and
        // that "stay excluded" outcome is already correct - the only cost of an optimistic answer
        // here is one wasted embed per model, bounded by MAX_ALTERNATE_ANN_MODELS.
        async () => true;
    const plan = await planAlternateAnnModels({ alternates, now: new Date(), apiKeyTable, isModelQueryable, logger });
    outcomes = await Promise.all(
      plan.selected.map(candidate => runAlternateModelAnn({ query, candidate, apiKeyTable, runAnn, logger }))
    );
    // plan.skipped is the only place a cap/credential/readiness/registry skip is visible - without
    // this it's indistinguishable in logs from "no alternate models were present at all".
    if (plan.skipped.length > 0) {
      logger?.debug?.('[semanticSearch] alternate-model buckets skipped', {
        skipped: plan.skipped.map(s => ({ model: s.model, reason: s.reason, fileCount: s.files.length })),
      });
    }
  }
  const servedByAlternateAnn = new Set(outcomes.flatMap(o => [...o.filesWithHits]));
  // Billable regardless of whether the ANN query itself then found anything - the embed call ran.
  const alternateModelsEmbedded = outcomes.filter(o => o.embedded).map(o => o.model);

  const mismatch = createEmbeddingMismatchAccumulator(excludedForeignFiles(servedByAlternateAnn), embeddingModel);
  for (let i = 0; i < annResult.hitsSkippedUnknownFile; i++) mismatch.skip('unknownFile');
  for (const outcome of outcomes) {
    for (let i = 0; i < outcome.hitsSkippedUnknownFile; i++) mismatch.skip('unknownFile');
  }

  const scanned = await scanAndRank({
    fileIds: scanEligible.map(f => f.id),
    fileById,
    queryEmbedding,
    topK,
    minScore,
    fileGroupSize: budgets.fileGroupSize,
    chunkPageSize,
    maxChunks: budgets.maxChunks,
    queryModel: embeddingModel,
    mismatch,
    fabfilechunks: args.fabfilechunks,
  });
  // A model counts as "served" only if it actually returned >=1 raw hit - a model that was
  // embedded and queried but found nothing served zero files, so its files correctly remain in
  // `excludedFiles` (via `servedByAlternateAnn` above) and must not also appear here.
  const servedOutcomes = outcomes.filter(o => o.filesWithHits.size > 0);
  if (servedOutcomes.length > 0) {
    mismatch.alternateModelServed(
      servedOutcomes.reduce((sum, o) => sum + o.filesWithHits.size, 0),
      servedOutcomes.map(o => o.model)
    );
  }
  const mismatchReport = mismatch.report();

  const alternateResults = outcomes.flatMap(o => o.results);
  const alternateHitsReturned = outcomes.reduce((sum, o) => sum + o.hitsReturned, 0);
  const alternateModelsQueried = outcomes.filter(o => o.embedded).length;

  // Merge every source into one bounded top-K - each already ranks its own subset, so this is a
  // cheap second pass over at most (2 + alternates)*topK items, not a rescore of the corpus.
  //
  // Cross-model caveat: raw cosine is NOT directly comparable across different embedding models -
  // their score distributions differ (see MEMENTO_MIN_SIMILARITY's documented history of exactly
  // this failure when a deployment's default model changed). Merging the primary and alternate
  // models' hits by raw cosine therefore systematically favors whichever model's scale runs
  // higher. With the data-lake surfaces' own default `minScore` of 0 this is purely a rank bias.
  // A caller-supplied nonzero minScore is a DIFFERENT, pre-existing property this cutover does
  // not change: the scan path already applies one floor across every chunk regardless of which
  // embedding space it came from, and this merge inherits that same behavior for alternate models
  // - a floor tuned for the primary model's scale can filter an entire alternate model's hits.
  // That model still counts as "served" in `alternateModelServed` (its ANN query DID run and
  // return raw hits, which is the file-level signal this report tracks - see `filesWithHits`),
  // not as excluded; a caller relying on `partial`/`excludedFiles` to catch every zero-result
  // cause under a custom minScore already has this gap for the primary model today. See the
  // pinned test for the accepted rank-bias behavior.
  const merged = new BoundedTopK<SemanticChunkResult>(topK, compareByScore);
  for (const result of scanned.results) merged.offer(result);
  for (const result of annResult.results) merged.offer(result);
  for (const result of alternateResults) merged.offer(result);
  const mergedResults = merged.drain();

  const scan: SemanticSearchScanAccounting = {
    truncated: args.fileBudgetHit || scanned.chunkBudgetHit,
    fileBudgetHit: args.fileBudgetHit,
    chunkBudgetHit: scanned.chunkBudgetHit,
    filesMatching: Math.max(args.filesMatching, fileIds.length),
    filesScoped: fileIds.length,
    filesScanned: scanned.filesScanned,
    chunksScanned: scanned.chunksScanned,
    chunksSkippedDimensionMismatch: scanned.chunksSkippedDimensionMismatch,
    annFilesQueried: annEligible.length + outcomes.reduce((sum, o) => sum + o.filesWithHits.size, 0),
    annHits: annResult.hitsReturned + alternateHitsReturned,
    annModelsQueried: (primaryAnnQueried ? 1 : 0) + alternateModelsQueried,
    budgets: { maxFiles: budgets.maxFiles, maxChunks: budgets.maxChunks },
  };

  if (scan.truncated) {
    logger?.warn?.(
      `[semanticSearch] TRUNCATED scan: ranked ${scan.chunksScanned} chunks across ${scan.filesScanned}/${scan.filesMatching} files ` +
        `(maxFiles=${scan.budgets.maxFiles}, maxChunks=${scan.budgets.maxChunks}) - results rank an INCOMPLETE corpus`
    );
  } else if (scan.chunksScanned > 0 && scan.chunksSkippedDimensionMismatch === scan.chunksScanned) {
    // Guarded on ALL chunks mismatching: a few stale chunks mid-revectorize are expected and must
    // stay quiet, but an entire corpus in the wrong vector space can never return anything.
    logger?.warn?.(
      `[semanticSearch] all ${scan.chunksScanned} scanned chunks were embedded at a different dimension than the ` +
        `${embeddingModel} query - the corpus needs re-vectorizing; returning no results`
    );
  }

  // Warn only when NOTHING could be compared by ANY path. A few withheld chunks mid-revectorize
  // are expected and must stay quiet - the same policy the truncation warning above applies, and
  // the reason unlabeled files and budgets do not raise the flag either. Excludes annResult.hitsReturned
  // and alternateHitsReturned (not annEligible.length/outcome file counts): a lake fully served by
  // ANN retrieval - the primary model, an alternate model, or both - legitimately scores zero
  // chunks on the scan path, and without this the warning would false-fire on every healthy
  // all-ANN search that also happens to have an unrelated excluded file elsewhere in scope.
  if (
    mismatchReport.partial &&
    scanned.chunksScored === 0 &&
    annResult.hitsReturned === 0 &&
    alternateHitsReturned === 0
  ) {
    logger?.warn?.('[semanticSearch] nothing could be compared in the query embedding space', {
      queryEmbeddingModel: embeddingModel,
      excludedFiles: mismatchReport.excludedFiles.count,
      excludedModels: mismatchReport.excludedFiles.models,
      excludedChunksEstimated: mismatchReport.excludedFiles.estimatedChunks,
      skippedChunks: mismatchReport.skippedChunks.byReason,
    });
  }
  // Unlabeled chunks are scored on the assumption they were embedded with the deployment default.
  // Under any other query model that assumption is probably wrong, and since we choose not to
  // exclude them, the choice needs to be auditable.
  if (mismatchReport.unlabeled.chunks > 0 && embeddingModel !== defaultEmbeddingModelForEnv()) {
    logger?.warn?.('[semanticSearch] scored chunks with no recorded embedding model', {
      queryEmbeddingModel: embeddingModel,
      assumedModel: defaultEmbeddingModelForEnv(),
      unlabeledChunks: mismatchReport.unlabeled.chunks,
      unlabeledFiles: mismatchReport.unlabeled.files,
    });
  }

  logger?.debug?.(
    `[semanticSearch] ${fileIds.length} files (${rankable.length} rankable, ${annEligible.length} via ${canUseAtlas ? 'atlas' : 'opensearch'} ${embeddingModel}), ${scan.chunksScanned} chunks scanned + ${scan.annHits} ann hits across ${scan.annModelsQueried} model(s) -> ${scanned.chunksScored} scored, ${mergedResults.length} above min ${minScore}, top score ${mergedResults[0]?.score?.toFixed(3) ?? 'n/a'}`
  );
  if (outcomes.length > 0) {
    logger?.debug?.(
      `[semanticSearch] alternate-model ANN: ${outcomes.map(o => `${o.model}=${o.failed ? 'failed' : `${o.hitsReturned}hits/${o.filesWithHits.size}files/${o.filesMissed.length}missed`}`).join(', ')}`
    );
  }

  return {
    results: mergedResults,
    totalChunksSearched: scan.chunksScanned,
    filesInScope: scan.filesScoped,
    chunksScored: scanned.chunksScored,
    embeddingMismatch: mismatchReport,
    embeddingModel,
    scan,
    alternateModelsEmbedded,
  };
}

export async function semanticDataLakeSearch(
  params: SemanticDataLakeSearchParams,
  adapters: SemanticDataLakeSearchAdapters
): Promise<SemanticDataLakeSearchResult> {
  const {
    userId,
    userGroups = [],
    query,
    tags = [],
    topK = 10,
    minScore = 0,
    embeddingModel,
    apiKeyTable,
    dataLakeTags,
    dataLakeTagPrefixes,
    scopedTagPrefixes = [],
    retrievalFilter = {},
    logger,
  } = params;

  const budgets = resolveBudgets(params.budgets);

  if (!query.trim() || dataLakeTags.length === 0) return emptyResult(embeddingModel, budgets);

  // --- Scope the files (metadata only) within the accessible data lakes ---
  const scoped = await collectScopedFiles({
    fabfiles: adapters.db.fabfiles,
    userId,
    userGroups,
    tags,
    dataLakeTags,
    dataLakeTagPrefixes,
    scopedTagPrefixes,
    retrievalFilter,
    maxFiles: budgets.maxFiles,
    filePageSize: budgets.filePageSize,
  });

  // Authoritative post-filter: never load vectors for or rank a file the caller excludes,
  // regardless of the DB regex engine or fileNameLower presence (see filterRetrievalExcluded).
  const scopedFiles = filterRetrievalExcluded(scoped.files, retrievalFilter);
  const fileIds = scopedFiles.map(f => f.id);
  if (fileIds.length === 0) {
    return emptyResult(embeddingModel, budgets, {
      truncated: scoped.fileBudgetHit,
      fileBudgetHit: scoped.fileBudgetHit,
      filesMatching: scoped.filesMatching,
    });
  }
  // Only the fields ranking needs, so each page's heavy file documents can be released. The
  // embedding model rides along because comparability is judged per file, not per chunk.
  const fileById = new Map<string, RankableFile>(
    scopedFiles.map(f => [
      f.id,
      {
        fileName: f.fileName,
        fileTags: f.tags?.map(t => t.name) ?? [],
        embeddingModel: f.embeddingModel,
        vectorizedChunkCount: f.vectorizedChunkCount,
        chunkEmbeddingModelStampedAt: f.chunkEmbeddingModelStampedAt,
      },
    ])
  );

  return rankChunksForFiles({
    query,
    fileIds,
    fileById,
    topK,
    minScore,
    embeddingModel,
    apiKeyTable,
    budgets,
    filesMatching: scoped.filesMatching,
    fileBudgetHit: scoped.fileBudgetHit,
    vectorSearchEnabled: params.vectorSearchEnabled ?? false,
    logger,
    fabfilechunks: adapters.db.fabfilechunks,
    vectorIndex: adapters.vectorIndex,
  });
}

export interface FileScopedSemanticSearchParams {
  /** Natural-language query - embedded and cosine-matched against chunk vectors. */
  query: string;
  /**
   * The EXACT files to search - a trusted, server-resolved allow-list (e.g. an agent's
   * kbScope). Empty means scoped-to-nothing and returns an empty result; this function
   * never widens beyond the list (no tags, no sharing, no data-lake resolution).
   */
  fileIds: string[];
  topK?: number;
  minScore?: number;
  embeddingModel: SupportedEmbeddingModel;
  apiKeyTable: SemanticDataLakeSearchParams['apiKeyTable'];
  /** Scan limits + paging tuning. Omit for the defaults. */
  budgets?: SemanticSearchBudgets;
  /** See SemanticDataLakeSearchParams.vectorSearchEnabled - same kill-switch, same default-off contract. */
  vectorSearchEnabled?: boolean;
  logger?: Logger;
}

export interface FileScopedSemanticSearchAdapters {
  db: {
    fabfiles: Pick<IFabFileRepository, 'getAccessibleFiles'>;
    fabfilechunks: FabFileChunksAdapter;
  };
  /** Self-host OpenSearch retrieval, undefined elsewhere - a separate cluster, not a Mongo repo method. */
  vectorIndex?: OpenSearchVectorSearchAdapters;
}

/**
 * File-first sibling of semanticDataLakeSearch for allow-list-scoped retrieval (agent KB
 * scope). Skips the tag-based file resolution entirely: the caller's fileIds ARE the scope,
 * so there is no dataLakeTags gate and no fabfiles.search. Metadata comes from
 * getAccessibleFiles (invalid-id-safe, content-projected) filtered to live files only, so
 * deleted/archived files curated into a scope contribute nothing.
 */
export async function fileScopedSemanticSearch(
  params: FileScopedSemanticSearchParams,
  adapters: FileScopedSemanticSearchAdapters
): Promise<SemanticDataLakeSearchResult> {
  const { query, fileIds, topK = 10, minScore = 0, embeddingModel, apiKeyTable, logger } = params;

  const budgets = resolveBudgets(params.budgets);

  if (!query.trim() || fileIds.length === 0) return emptyResult(embeddingModel, budgets);

  const files = await adapters.db.fabfiles.getAccessibleFiles(fileIds, { deletedAt: null, archivedAt: null });
  if (files.length === 0) return emptyResult(embeddingModel, budgets);

  // getAccessibleFiles imposes no order, so sort before applying the budget: otherwise WHICH
  // files an over-budget curated scope drops would be Mongo's natural order and could differ
  // between two identical calls.
  const ordered = [...files].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const withinBudget = ordered.slice(0, budgets.maxFiles);
  const fileBudgetHit = ordered.length > withinBudget.length;

  const fileById = new Map<string, RankableFile>(
    withinBudget.map(f => [
      f.id,
      {
        fileName: f.fileName,
        fileTags: f.tags?.map(t => t.name) ?? [],
        embeddingModel: f.embeddingModel,
        vectorizedChunkCount: f.vectorizedChunkCount,
        chunkEmbeddingModelStampedAt: f.chunkEmbeddingModelStampedAt,
      },
    ])
  );

  return rankChunksForFiles({
    query,
    fileIds: withinBudget.map(f => f.id),
    fileById,
    topK,
    minScore,
    embeddingModel,
    apiKeyTable,
    budgets,
    filesMatching: ordered.length,
    fileBudgetHit,
    vectorSearchEnabled: params.vectorSearchEnabled ?? false,
    logger,
    fabfilechunks: adapters.db.fabfilechunks,
    vectorIndex: adapters.vectorIndex,
  });
}
