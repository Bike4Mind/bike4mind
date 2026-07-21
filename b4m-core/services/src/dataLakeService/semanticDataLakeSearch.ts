import {
  FabFileChunkVector,
  IFabFileChunkRepository,
  IFabFileRepository,
  SupportedEmbeddingModel,
} from '@bike4mind/common';
import { computeCosineSimilarity, EmbeddingFactory, getProviderFromModel } from '@bike4mind/utils';
import { filterRetrievalExcluded, type RetrievalExclusionOptions } from '@bike4mind/utils/retrievalExclusion';
import { Logger } from '@bike4mind/observability';

/**
 * Shared vector/semantic search over FabFile chunks in a user's accessible data lakes.
 *
 * Extracted from POST /api/opti/semantic-search so the endpoint, the chat KB tool, and the
 * RLM tools all run ONE implementation in-process (no HTTP loopback). Modeled on the
 * dependency-injected getRelevantMementos pattern: pure, adapter-injected, never imports
 * @bike4mind/database. Reuses EmbeddingFactory (query embed) + computeCosineSimilarity
 * (ranking) + the chunk vectors the fabFileVectorize pipeline already populates.
 *
 * Data-lake SCOPING is the caller's concern (passed as dataLakeTags + dataLakeTagPrefixes):
 * the endpoint computes it from DATA_LAKES, the chat tool from getDynamicDataLakeAccess,
 * so this stays a single retrieval primitive.
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
  filesInScope: number;
  embeddingModel: string;
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
   * /api/opti/semantic-search) stays un-regressed when omitted. See @bike4mind/utils/retrievalExclusion.
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
  tags?: { name: string }[];
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

  // --- Bulk-load vector-bearing chunks (single indexed query) and cosine-rank ---
  const chunks = await args.fabfilechunks.findVectorsByFabFileIds(fileIds, chunkLoadCap);

  const scored: SemanticChunkResult[] = [];
  for (const chunk of chunks as FabFileChunkVector[]) {
    if (!chunk.vector || chunk.vector.length !== queryDim) continue; // skip dim mismatches (model changed)
    const score = computeCosineSimilarity(queryEmbedding, chunk.vector);
    if (score < minScore) continue;
    const file = fileById.get(chunk.fabFileId);
    if (!file) continue;
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
  logger?.debug?.(
    `[semanticSearch] ${fileIds.length} files, ${chunks.length} chunks → ${scored.length} above min ${minScore}, top score ${scored[0]?.score?.toFixed(3) ?? 'n/a'}`
  );

  return {
    results: scored.slice(0, topK),
    totalChunksSearched: chunks.length,
    filesInScope: fileIds.length,
    embeddingModel,
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
    embeddingModel,
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
    embeddingModel,
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
