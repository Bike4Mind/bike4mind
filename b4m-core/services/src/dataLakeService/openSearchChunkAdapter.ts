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
 * Positive-only memo of "this index exists" - a missing index is a startup-shaped condition
 * (before the first chunk for a model is ever indexed), not a per-query one, so paying an
 * `indexExists` round-trip on every single search is wasted once it has been seen to exist.
 * Never cache a negative: that IS the condition that changes (the first `indexChunks` call for
 * a model creates it), and caching `false` would keep this adapter fail-closed forever.
 *
 * Exported (not module-private) so tests can `.clear()` it between cases - otherwise a positive
 * result cached by an earlier test silently skips the `indexExists` call the next test asserts on.
 */
export const knownExistingIndexes = new Set<string>();

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
    if (!knownExistingIndexes.has(indexName)) {
      const exists = await client.indexExists(indexName);
      if (!exists) return [];
      knownExistingIndexes.add(indexName);
    }

    const limit = options.limit ?? 50;
    const hits = await client.knnQuery(indexName, queryVector, candidatePool(limit, fileIds.length), {
      filter: {
        bool: {
          filter: [{ terms: { 'metadata.fabFileId': fileIds } }, { term: { 'metadata.embeddingModel': model } }],
        },
      },
      // size bounds what actually crosses the wire; k above stays the (larger) candidate pool
      // the kNN engine ranks internally. Without this split, size defaulted to k and every query
      // shipped its whole candidate pool - up to 10,000 documents, each carrying its full
      // embedding vector - to return `limit` results.
      size: limit,
      excludeSource: ['vector'],
    });

    // size above already bounds the response; slice is a no-op safety net, not the real bound.
    return hits.slice(0, limit).map(hit => ({
      id: hit.id,
      fabFileId: String(hit.source.metadata?.fabFileId ?? ''),
      text: String(hit.source.text ?? ''),
      score: hit.score,
    }));
  },
};
