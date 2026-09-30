import { supportsAtlasVectorSearch } from '@bike4mind/db-core';
import type { IFabFileChunkRepository } from '@bike4mind/common';
import { annVectorSearch, type AnnRankableFile, type AnnVectorSearchResult } from './annVectorSearch';

export interface AtlasVectorSearchAdapters {
  vectorSearch(
    fileIds: string[],
    queryVector: number[],
    model: string,
    options?: { limit?: number; includeText?: boolean }
  ): Promise<Array<{ id: string; fabFileId: string; text: string; score: number }>>;
}

export type AtlasVectorSearchResult = AnnVectorSearchResult;

type AtlasAnnMethods = Pick<IFabFileChunkRepository, 'vectorSearch' | 'getAtlasIndexStatus'>;

/**
 * Whether Atlas ANN can serve this deployment: an Atlas backend plus both repository methods.
 * The one gate for every Atlas ANN caller (semanticDataLakeSearch, forced retrieval's candidate
 * pick). The `EnableDataLakeVectorSearch` setting is deliberately NOT read here - each caller
 * owns that read (see `vectorSearchEnabled` on semanticDataLakeSearch).
 */
export function isAtlasVectorSearchAvailable<T extends Partial<AtlasAnnMethods>>(
  fabfilechunks: T | undefined
): fabfilechunks is T & AtlasAnnMethods {
  return supportsAtlasVectorSearch() && !!fabfilechunks?.vectorSearch && !!fabfilechunks.getAtlasIndexStatus;
}

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
  fileById: Map<string, AnnRankableFile>;
  queryVector: number[];
  model: string;
  limit: number;
  minScore: number;
  /** Forwarded to the adapter; `false` skips chunk bodies for callers that only rank by score. */
  includeText?: boolean;
  adapters: AtlasVectorSearchAdapters;
}): Promise<AtlasVectorSearchResult> {
  const { adapters, ...rest } = args;
  // A bare `{ knnSearch: adapters.vectorSearch }` strips `this` - the real adapter is a
  // repository instance whose method reads `this.fabFileChunkModel`, so calling it unbound
  // throws. The wrapper closure keeps the call bound to `adapters`.
  return annVectorSearch({
    ...rest,
    adapter: { knnSearch: (...callArgs) => adapters.vectorSearch(...callArgs) },
  });
}
