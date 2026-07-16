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
  apiKeyTable: { openai?: string | null; voyageai?: string | null } | null | undefined;
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

  // --- Embed the query (reuse EmbeddingFactory; pick the provider the model needs) ---
  const provider = getProviderFromModel(embeddingModel);
  const embeddingConfig: { openaiApiKey?: string | null; voyageApiKey?: string | null } = {};
  if (provider === 'openai') {
    if (!apiKeyTable?.openai) throw new Error('OpenAI API key required for semantic search but not found.');
    embeddingConfig.openaiApiKey = apiKeyTable.openai;
  } else if (provider === 'voyageai') {
    if (!apiKeyTable?.voyageai) throw new Error('VoyageAI API key required for semantic search but not found.');
    embeddingConfig.voyageApiKey = apiKeyTable.voyageai;
  }
  const embeddingService = new EmbeddingFactory(embeddingConfig).createEmbeddingService(embeddingModel);
  const queryEmbedding = await embeddingService.generateEmbedding(query);
  const queryDim = queryEmbedding.length;

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
  const fileById = new Map(scopedFiles.map(f => [f.id, f]));

  // --- Bulk-load vector-bearing chunks (single indexed query) and cosine-rank ---
  const chunks = await adapters.db.fabfilechunks.findVectorsByFabFileIds(fileIds, chunkLoadCap);

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
    `[semanticDataLakeSearch] ${fileIds.length} files, ${chunks.length} chunks → ${scored.length} above min ${minScore}, top score ${scored[0]?.score?.toFixed(3) ?? 'n/a'}`
  );

  return {
    results: scored.slice(0, topK),
    totalChunksSearched: chunks.length,
    filesInScope: fileIds.length,
    embeddingModel,
  };
}
