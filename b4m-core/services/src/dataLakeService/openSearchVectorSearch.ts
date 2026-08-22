import { annVectorSearch, type AnnVectorSearchResult } from './annVectorSearch';

export interface OpenSearchVectorSearchAdapters {
  knnSearch(
    fileIds: string[],
    queryVector: number[],
    model: string,
    options?: { limit?: number }
  ): Promise<Array<{ id: string; fabFileId: string; text: string; score: number }>>;
}

export type OpenSearchVectorSearchResult = AnnVectorSearchResult;

/**
 * Run a self-host OpenSearch kNN query over an already-eligibility-checked file subset and
 * shape the hits into the same `SemanticChunkResult` rows the brute-force scan and the Atlas
 * path produce, so all three can merge into one BoundedTopK.
 *
 * The scoring/shaping/minScore logic lives in annVectorSearch.ts, shared with the Atlas path
 * (atlasVectorSearch.ts) - this adapter already matches the shared `knnSearch` shape directly,
 * so this wrapper is a pass-through. The `2 * score - 1` denormalization there is identical to
 * Atlas's, not a coincidence: config.ts's index mapping deliberately pins `engine: 'lucene',
 * space_type: 'cosinesimil'`, under which OpenSearch's k-NN score is `(1 + cosine) / 2` - the
 * same normalized range Atlas's `similarity: 'cosine'` scoring uses. If that mapping ever
 * changes engine/space_type, annVectorSearch.ts's formula must be revisited alongside it.
 */
export async function openSearchVectorSearch(args: {
  fileIds: string[];
  fileById: Map<string, { fileName: string; fileTags: string[] }>;
  queryVector: number[];
  model: string;
  limit: number;
  minScore: number;
  adapters: OpenSearchVectorSearchAdapters;
}): Promise<OpenSearchVectorSearchResult> {
  const { adapters, ...rest } = args;
  return annVectorSearch({ ...rest, adapter: adapters });
}
