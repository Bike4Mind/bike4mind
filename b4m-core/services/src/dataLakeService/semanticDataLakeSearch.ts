import {
  DATA_LAKE_SEARCH_MAX_CHUNKS_DEFAULT,
  DATA_LAKE_SEARCH_MAX_FILES_DEFAULT,
  FabFileChunkVector,
  IFabFileChunkRepository,
  IFabFileDocument,
  IFabFileRepository,
  SupportedEmbeddingModel,
} from '@bike4mind/common';
import { computeCosineSimilarity, EmbeddingFactory, getProviderFromModel } from '@bike4mind/utils';
import { filterRetrievalExcluded, type RetrievalExclusionOptions } from '@bike4mind/utils/retrievalExclusion';
import { Logger } from '@bike4mind/observability';
import { BoundedTopK } from './boundedTopK';

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
  /** Budgets in force, echoed so a caller can explain a truncation without guessing. */
  budgets: { maxFiles: number; maxChunks: number };
}

export interface SemanticDataLakeSearchResult {
  results: SemanticChunkResult[];
  /** Same value as `scan.chunksScanned`; retained for existing consumers. */
  totalChunksSearched: number;
  /** Same value as `scan.filesScoped`; retained for existing consumers. */
  filesInScope: number;
  embeddingModel: string;
  scan: SemanticSearchScanAccounting;
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
  logger?: Logger;
}

export interface SemanticDataLakeSearchAdapters {
  db: {
    fabfiles: Pick<IFabFileRepository, 'search'>;
    fabfilechunks: Pick<IFabFileChunkRepository, 'findVectorsByFabFileIds'>;
  };
}

/** Shape both entrypoints need from a scoped file's metadata. */
interface RankableFile {
  fileName: string;
  fileTags: string[];
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

function resolveBudgets(budgets: SemanticSearchBudgets | undefined) {
  return {
    maxFiles: budgets?.maxFiles ?? DATA_LAKE_SEARCH_MAX_FILES_DEFAULT,
    maxChunks: budgets?.maxChunks ?? DATA_LAKE_SEARCH_MAX_CHUNKS_DEFAULT,
    filePageSize: budgets?.filePageSize ?? DEFAULT_FILE_PAGE_SIZE,
    fileGroupSize: budgets?.fileGroupSize ?? DEFAULT_FILE_GROUP_SIZE,
    chunkPageSize: budgets?.chunkPageSize,
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
    embeddingModel,
    scan: { ...emptyScanAccounting(budgets), ...overrides },
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
  fabfilechunks: Pick<IFabFileChunkRepository, 'findVectorsByFabFileIds'>;
}): Promise<{
  results: SemanticChunkResult[];
  chunksScanned: number;
  chunksSkippedDimensionMismatch: number;
  filesScanned: number;
  chunkBudgetHit: boolean;
}> {
  const { fileIds, fileById, queryEmbedding, topK, minScore, fileGroupSize, chunkPageSize, maxChunks } = args;
  const queryDim = queryEmbedding.length;
  const ranked = new BoundedTopK<SemanticChunkResult>(topK, compareByScore);

  let chunksScanned = 0;
  let chunksSkippedDimensionMismatch = 0;
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
        if (!chunk.vector || chunk.vector.length !== queryDim) {
          // A width mismatch means the chunk was embedded under a different model, so its vector
          // lives in a different space and cosine against it is meaningless. Counted, not silent.
          chunksSkippedDimensionMismatch++;
          continue;
        }
        const score = computeCosineSimilarity(queryEmbedding, chunk.vector);
        // A zero-magnitude vector makes cosine NaN, and NaN fails every comparison: it would slip
        // past `score < minScore` and, because it also fails the top-K reject test, sort ahead of
        // every real hit.
        if (!Number.isFinite(score)) continue;
        if (score < minScore) continue;
        const file = fileById.get(chunk.fabFileId);
        if (!file) continue;
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
    chunksSkippedDimensionMismatch,
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
  logger?: Logger;
  fabfilechunks: Pick<IFabFileChunkRepository, 'findVectorsByFabFileIds'>;
}): Promise<SemanticDataLakeSearchResult> {
  const { query, fileIds, fileById, topK, minScore, embeddingModel, apiKeyTable, budgets, logger } = args;

  // --- Embed the query (reuse EmbeddingFactory; pick the provider the model needs) ---
  const provider = getProviderFromModel(embeddingModel);
  const embeddingConfig: { openaiApiKey?: string | null; voyageApiKey?: string | null; ollamaBaseUrl?: string | null } =
    {};
  if (provider === 'openai') {
    if (!apiKeyTable?.openai) throw new Error('OpenAI API key required for semantic search but not found.');
    embeddingConfig.openaiApiKey = apiKeyTable.openai;
  } else if (provider === 'voyageai') {
    if (!apiKeyTable?.voyageai) throw new Error('VoyageAI API key required for semantic search but not found.');
    embeddingConfig.voyageApiKey = apiKeyTable.voyageai;
  } else if (provider === 'ollama') {
    // apiKeyTable.ollama carries the Ollama base URL (no secret) in self-host.
    if (!apiKeyTable?.ollama) throw new Error('Ollama base URL required for semantic search but not found.');
    embeddingConfig.ollamaBaseUrl = apiKeyTable.ollama;
  }
  const embeddingService = new EmbeddingFactory(embeddingConfig).createEmbeddingService(embeddingModel);
  const queryEmbedding = await embeddingService.generateEmbedding(query);

  const chunkPageSize =
    budgets.chunkPageSize ??
    Math.min(
      MAX_CHUNK_PAGE_SIZE,
      Math.max(MIN_CHUNK_PAGE_SIZE, Math.floor(CHUNK_PAGE_TARGET_FLOATS / Math.max(1, queryEmbedding.length)))
    );

  const scanned = await scanAndRank({
    fileIds,
    fileById,
    queryEmbedding,
    topK,
    minScore,
    fileGroupSize: budgets.fileGroupSize,
    chunkPageSize,
    maxChunks: budgets.maxChunks,
    fabfilechunks: args.fabfilechunks,
  });

  const scan: SemanticSearchScanAccounting = {
    truncated: args.fileBudgetHit || scanned.chunkBudgetHit,
    fileBudgetHit: args.fileBudgetHit,
    chunkBudgetHit: scanned.chunkBudgetHit,
    filesMatching: Math.max(args.filesMatching, fileIds.length),
    filesScoped: fileIds.length,
    filesScanned: scanned.filesScanned,
    chunksScanned: scanned.chunksScanned,
    chunksSkippedDimensionMismatch: scanned.chunksSkippedDimensionMismatch,
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

  logger?.debug?.(
    `[semanticSearch] ${fileIds.length} files, ${scan.chunksScanned} chunks -> ${scanned.results.length} above min ${minScore}, top score ${scanned.results[0]?.score?.toFixed(3) ?? 'n/a'}`
  );

  return {
    results: scanned.results,
    totalChunksSearched: scan.chunksScanned,
    filesInScope: scan.filesScoped,
    embeddingModel,
    scan,
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
  // Only the two fields ranking needs, so each page's heavy file documents can be released.
  const fileById = new Map<string, RankableFile>(
    scopedFiles.map(f => [f.id, { fileName: f.fileName, fileTags: f.tags?.map(t => t.name) ?? [] }])
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
    logger,
    fabfilechunks: adapters.db.fabfilechunks,
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
  logger?: Logger;
}

export interface FileScopedSemanticSearchAdapters {
  db: {
    fabfiles: Pick<IFabFileRepository, 'getAccessibleFiles'>;
    fabfilechunks: Pick<IFabFileChunkRepository, 'findVectorsByFabFileIds'>;
  };
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
    withinBudget.map(f => [f.id, { fileName: f.fileName, fileTags: f.tags?.map(t => t.name) ?? [] }])
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
    logger,
    fabfilechunks: adapters.db.fabfilechunks,
  });
}
