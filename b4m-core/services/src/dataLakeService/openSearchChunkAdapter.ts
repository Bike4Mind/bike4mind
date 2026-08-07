import { FabFileChunkSearchIndex, selfHostVectorIndexName } from '@bike4mind/fab-pipeline';
import type { OpenSearchVectorSearchAdapters } from './openSearchVectorSearch';

/**
 * Candidate pool scaled by file-set size, mirroring FabFileModel.vectorSearch's Atlas
 * numCandidates - a query scoped to a handful of files out of a much larger shared index still
 * needs enough candidates for the kNN engine's filter to have something to rank. Floored at
 * 100, capped well below a typical self-host corpus size.
 */
function candidatePool(limit: number, fileCount: number): number {
  return Math.min(10_000, Math.max(limit * 10, fileCount * 50, 100));
}

/**
 * Concrete self-host OpenSearch adapter for openSearchVectorSearch.ts. Fails CLOSED (returns
 * []) rather than throwing on a missing index/model - the caller (semanticDataLakeSearch.ts)
 * treats an empty result as "not queryable" and rebuckets the whole request onto the scan path.
 */
export const openSearchChunkAdapter: OpenSearchVectorSearchAdapters = {
  async knnSearch(fileIds, queryVector, model, options = {}) {
    const indexName = selfHostVectorIndexName(model);
    if (!indexName) return [];

    const client = await FabFileChunkSearchIndex.loadSearchIndexClient();
    const exists = await client.indexExists(indexName);
    if (!exists) return [];

    const limit = options.limit ?? 50;
    const hits = await client.knnQuery(indexName, queryVector, candidatePool(limit, fileIds.length), {
      bool: {
        filter: [{ terms: { 'metadata.fabFileId': fileIds } }, { term: { 'metadata.embeddingModel': model } }],
      },
    });

    return hits.slice(0, limit).map(hit => ({
      id: hit.id,
      fabFileId: String(hit.source.metadata?.fabFileId ?? ''),
      text: String(hit.source.text ?? ''),
      score: hit.score,
    }));
  },
};
