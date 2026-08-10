import { annVectorSearch, type AnnVectorSearchResult } from './annVectorSearch';

export interface AtlasVectorSearchAdapters {
  vectorSearch(
    fileIds: string[],
    queryVector: number[],
    model: string,
    options?: { limit?: number }
  ): Promise<Array<{ id: string; fabFileId: string; text: string; score: number }>>;
}

export type AtlasVectorSearchResult = AnnVectorSearchResult;

/**
 * Run Atlas `$vectorSearch` over an already-eligibility-checked file subset (see
 * vectorSearchEligibility.ts) and shape the hits into the same `SemanticChunkResult` rows the
 * brute-force scan produces, so the two can merge into one BoundedTopK.
 *
 * The scoring/shaping/minScore logic lives in annVectorSearch.ts, shared with the self-host
 * OpenSearch path (openSearchVectorSearch.ts) - both backends normalize to the same [0,1] cosine
 * range, so this wrapper only adapts Atlas's `vectorSearch` method name to the shared shape.
 */
export async function atlasVectorSearch(args: {
  fileIds: string[];
  fileById: Map<string, { fileName: string; fileTags: string[] }>;
  queryVector: number[];
  model: string;
  limit: number;
  minScore: number;
  adapters: AtlasVectorSearchAdapters;
}): Promise<AtlasVectorSearchResult> {
  const { adapters, ...rest } = args;
  return annVectorSearch({ ...rest, adapter: { knnSearch: adapters.vectorSearch } });
}
