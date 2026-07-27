import {
  defaultEmbeddingModelForEnv,
  FabFileChunkVector,
  IFabFileChunkRepository,
  IFabFileRepository,
  SupportedEmbeddingModel,
} from '@bike4mind/common';
import { computeCosineSimilarity, EmbeddingFactory, getProviderFromModel } from '@bike4mind/utils';
import { filterRetrievalExcluded, type RetrievalExclusionOptions } from '@bike4mind/utils/retrievalExclusion';
import { Logger } from '@bike4mind/observability';
import {
  classifyLoadedChunk,
  createEmbeddingMismatchAccumulator,
  emptyEmbeddingMismatchReport,
  partitionFilesByEmbeddingModel,
  type EmbeddingMismatchReport,
} from './embeddingMismatch';

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
 * Data-lake SCOPING is the caller's concern (passed as dataLakeTags + the two prefix
 * buckets). Both the endpoint and the chat tool now compute it from
 * getDynamicDataLakeAccess, so this stays a single retrieval primitive fed by a single
 * access resolver.
 */

export interface SemanticChunkResult {
  chunkId: string;
  fileId: string;
  fileName: string;
  fileTags: string[];
  chunkText: string;
  score: number;
}

export interface SemanticDataLakeSearchResult {
  results: SemanticChunkResult[];
  totalChunksSearched: number;
  /** Every file the scope resolved to, including any withheld as embedded with another model. */
  filesInScope: number;
  /** Loaded chunks actually cosine-scored. With skippedChunks.total this sums to totalChunksSearched. */
  chunksScored: number;
  embeddingModel: string;
  /** What retrieval could not compare, so a caller never reports a partial result as complete. */
  embeddingMismatch: EmbeddingMismatchReport;
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
  /** Max files to scope (fabfiles.search page size). Default 2000. */
  maxFiles?: number;
  /** Max chunk vectors loaded into memory. Default 10_000. */
  chunkLoadCap?: number;
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

/**
 * Shape both entrypoints need from a scoped file's metadata. Structural on purpose: the FabFile
 * documents both projections return already carry these, so neither entrypoint needs a mapper.
 * embeddingModel is the only record of which embedding space a file's chunks live in - chunks
 * themselves carry no model or dimension - so it is what mismatch detection reads.
 */
interface RankableFile {
  fileName: string;
  tags?: { name: string }[];
  embeddingModel?: string | null;
  vectorizedChunkCount?: number;
  /** Read when deciding whether an excluded file actually withheld any vectors. */
  vectorized?: boolean;
}

/**
 * Shared ranking core: embed the query, bulk-load vector-bearing chunks for the given
 * files, cosine-rank, and shape the result. File-source-agnostic - the two entrypoints
 * below differ ONLY in how they resolve { fileIds, fileById } (tag-scoped browse vs an
 * explicit allow-list), so the embedding/provider handling can never drift between them.
 */
async function rankChunksForFiles(args: {
  query: string;
  fileIds: string[];
  fileById: Map<string, RankableFile>;
  topK: number;
  minScore: number;
  embeddingModel: SupportedEmbeddingModel;
  apiKeyTable: SemanticDataLakeSearchParams['apiKeyTable'];
  chunkLoadCap: number;
  /** Whether the caller's file scope was itself capped, and how many files matched in total. */
  fileCapHit?: boolean;
  filesTotal?: number | null;
  logger?: Logger;
  fabfilechunks: Pick<IFabFileChunkRepository, 'findVectorsByFabFileIds'>;
}): Promise<SemanticDataLakeSearchResult> {
  const { query, fileIds, fileById, topK, minScore, embeddingModel, apiKeyTable, chunkLoadCap, logger } = args;

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
  const queryDim = queryEmbedding.length;

  // --- Withhold files whose recorded model puts their vectors in another embedding space ---
  // Done at the file level, before any vector load: foreign vectors then never enter memory and
  // never spend the chunk cap, which is unordered and would otherwise let one large off-model
  // file evict chunks that could have matched.
  // Pluck the declared fields rather than spreading the doc: RankableFile carries no `id`, so a
  // spread would leave the partition input's shape resting on the runtime doc happening to have one.
  const scopedFiles = fileIds.map(id => {
    const file = fileById.get(id);
    return {
      id,
      fileName: file?.fileName,
      embeddingModel: file?.embeddingModel,
      vectorizedChunkCount: file?.vectorizedChunkCount,
      vectorized: file?.vectorized,
    };
  });
  const { rankable, foreign } = partitionFilesByEmbeddingModel(scopedFiles, embeddingModel);
  const mismatch = createEmbeddingMismatchAccumulator(foreign, embeddingModel);
  mismatch.truncation({ fileCapHit: args.fileCapHit ?? false, filesTotal: args.filesTotal ?? null });

  // An empty query embedding would make every chunk look like a width mismatch and return
  // nothing. Report it rather than ranking against a meaningless vector, and do not throw: a
  // transient provider hiccup should not turn a search into a 500.
  if (queryDim === 0) {
    logger?.warn?.('[semanticSearch] query embedding came back empty, nothing can be ranked', {
      queryEmbeddingModel: embeddingModel,
      filesInScope: fileIds.length,
    });
    mismatch.queryEmbeddingFailed();
    return {
      results: [],
      totalChunksSearched: 0,
      filesInScope: fileIds.length,
      chunksScored: 0,
      embeddingModel,
      embeddingMismatch: mismatch.report(),
    };
  }

  // --- Bulk-load vector-bearing chunks (single indexed query) and cosine-rank ---
  // Ask for one past the cap so a corpus holding EXACTLY chunkLoadCap chunks is not reported as
  // truncated. Same limit+1 probe the file search uses for hasMore.
  const rankableIds = rankable.map(f => f.id);
  const loaded = rankableIds.length
    ? await args.fabfilechunks.findVectorsByFabFileIds(rankableIds, chunkLoadCap + 1)
    : [];
  const chunkCapHit = loaded.length > chunkLoadCap;
  const chunks = chunkCapHit ? loaded.slice(0, chunkLoadCap) : loaded;
  mismatch.truncation({ chunkCapHit });

  const scored: SemanticChunkResult[] = [];
  let chunksScored = 0;
  for (const chunk of chunks as FabFileChunkVector[]) {
    // Resolve the parent first: it carries the embedding model, and an orphan chunk cannot be
    // attributed to any model. Doing it before scoring is also what keeps the counts exact.
    const file = fileById.get(chunk.fabFileId);
    if (!file) {
      mismatch.skip('unknownFile');
      continue;
    }
    const skipReason = classifyLoadedChunk({
      vector: chunk.vector,
      queryDim,
      parentFile: file,
      queryModel: embeddingModel,
    });
    if (skipReason) {
      mismatch.skip(skipReason);
      continue;
    }
    chunksScored++;
    mismatch.scored(file, chunk.fabFileId);
    const score = computeCosineSimilarity(queryEmbedding, chunk.vector);
    // Below the caller's floor: ranked and rejected on merit, so not a withheld chunk.
    if (score < minScore) continue;
    scored.push({
      chunkId: chunk.id,
      fileId: chunk.fabFileId,
      fileName: file.fileName,
      fileTags: file.tags?.map(t => t.name) ?? [],
      chunkText: chunk.text ?? '',
      score,
    });
  }

  scored.sort((a, b) => b.score - a.score);
  const report = mismatch.report();
  logger?.debug?.(
    `[semanticSearch] ${fileIds.length} files (${rankableIds.length} rankable), ${chunks.length} chunks -> ${chunksScored} scored, ${report.skippedChunks.total} skipped, ${scored.length} above min ${minScore}, top score ${scored[0]?.score?.toFixed(3) ?? 'n/a'}`
  );
  if (report.partial) {
    logger?.warn?.('[semanticSearch] retrieval returned partial results', {
      queryEmbeddingModel: embeddingModel,
      queryDim,
      filesInScope: fileIds.length,
      filesRanked: rankableIds.length,
      excludedFiles: report.excludedFiles.count,
      excludedModels: report.excludedFiles.models,
      excludedChunksEstimated: report.excludedFiles.estimatedChunks,
      chunksLoaded: chunks.length,
      chunksScored,
      skippedChunks: report.skippedChunks.byReason,
      truncated: report.truncated,
    });
  }
  // Unlabeled chunks are scored on the assumption that they were embedded with the deployment
  // default. Under any other query model that assumption is probably wrong, and since we choose
  // not to exclude them, the choice needs to be auditable.
  if (report.unlabeled.chunks > 0 && embeddingModel !== defaultEmbeddingModelForEnv()) {
    logger?.warn?.('[semanticSearch] scored chunks with no recorded embedding model', {
      queryEmbeddingModel: embeddingModel,
      assumedModel: defaultEmbeddingModelForEnv(),
      unlabeledChunks: report.unlabeled.chunks,
      unlabeledFiles: report.unlabeled.files,
    });
  }

  return {
    results: scored.slice(0, topK),
    totalChunksSearched: chunks.length,
    filesInScope: fileIds.length,
    chunksScored,
    embeddingModel,
    embeddingMismatch: report,
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
    maxFiles = 2000,
    chunkLoadCap = 10_000,
    retrievalFilter = {},
    logger,
  } = params;

  const empty: SemanticDataLakeSearchResult = {
    results: [],
    totalChunksSearched: 0,
    filesInScope: 0,
    chunksScored: 0,
    embeddingModel,
    embeddingMismatch: emptyEmbeddingMismatchReport(),
  };

  if (!query.trim() || dataLakeTags.length === 0) return empty;

  // --- Scope the files (metadata only) within the accessible data lakes ---
  const fileSearch = await adapters.db.fabfiles.search(
    userId,
    '', // no text query - pure data-lake browse; relevance comes from vector cosine below
    { tags, shared: false },
    { page: 1, limit: maxFiles },
    { by: 'fileName', direction: 'asc' },
    {
      textSearch: false,
      includeShared: true,
      userGroups,
      dataLakeTags,
      dataLakeTagPrefixes,
      scopedTagPrefixes,
      excludeContent: true,
      // Retrieval exclusion (caller-driven) - best-effort DB pre-filter; the authoritative
      // in-memory pass below guarantees excluded files are dropped before any chunk load.
      ...retrievalFilter,
    }
  );

  // Authoritative post-filter: never load vectors for or rank a file the caller excludes,
  // regardless of the DB regex engine or fileNameLower presence (see filterRetrievalExcluded).
  const scopedFiles = filterRetrievalExcluded(fileSearch.data, retrievalFilter);
  const fileIds = scopedFiles.map(f => f.id);
  if (fileIds.length === 0) return empty;
  const fileById = new Map<string, RankableFile>(scopedFiles.map(f => [f.id, f]));

  return rankChunksForFiles({
    query,
    fileIds,
    fileById,
    topK,
    minScore,
    embeddingModel,
    apiKeyTable,
    chunkLoadCap,
    // fileName-ordered page: past maxFiles the tail never enters scope, so say so rather than
    // letting the result read as a complete search of the lake. hasMore is the only sound
    // signal here (it comes from a limit+1 probe); total counts before the in-memory retrieval
    // filter, so comparing it against fileIds would flag a cap hit whenever that filter drops one.
    fileCapHit: fileSearch.hasMore === true,
    filesTotal: fileSearch.total ?? null,
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
  chunkLoadCap?: number;
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
  const {
    query,
    fileIds,
    topK = 10,
    minScore = 0,
    embeddingModel,
    apiKeyTable,
    chunkLoadCap = 10_000,
    logger,
  } = params;

  const empty: SemanticDataLakeSearchResult = {
    results: [],
    totalChunksSearched: 0,
    filesInScope: 0,
    chunksScored: 0,
    embeddingModel,
    embeddingMismatch: emptyEmbeddingMismatchReport(),
  };

  if (!query.trim() || fileIds.length === 0) return empty;

  const files = await adapters.db.fabfiles.getAccessibleFiles(fileIds, { deletedAt: null, archivedAt: null });
  if (files.length === 0) return empty;
  const liveIds = files.map(f => f.id);
  const fileById = new Map<string, RankableFile>(files.map(f => [f.id, f]));

  return rankChunksForFiles({
    query,
    fileIds: liveIds,
    fileById,
    topK,
    minScore,
    embeddingModel,
    apiKeyTable,
    chunkLoadCap,
    logger,
    fabfilechunks: adapters.db.fabfilechunks,
  });
}
