import type { IFabFileChunkDocument } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { BaseSearchIndex } from './BaseSearchIndex';
import { OpenSearchClient } from './opensearchClient';
import { getEmbeddingDimensions, atlasVectorIndexName } from './atlasSearchIndex';
import { SearchDocument, buildSearchIndexSettings } from './config';

/** OpenSearch index names allow only lowercase letters, numbers, hyphens and underscores. */
export const selfHostVectorIndexName = (model: string): string | null => {
  const dimension = getEmbeddingDimensions(model);
  if (dimension == null) return null;
  return atlasVectorIndexName(model, dimension).toLowerCase();
};

let cachedClient: OpenSearchClient | null = null;

/**
 * Self-host OpenSearch retrieval for Data Lake chunk vectors, one index per embedding model
 * (mirrors the Atlas cutover's per-model index registry - see atlasSearchIndex.ts). One
 * OpenSearch document per FabFileChunk, id = chunk id.
 */
export class FabFileChunkSearchIndex extends BaseSearchIndex {
  constructor(chunk: IFabFileChunkDocument) {
    const indexName = chunk.embeddingModel ? selfHostVectorIndexName(chunk.embeddingModel) : null;
    // BaseSearchIndex requires a name at construction time; an unresolvable name is caught in
    // mapDocument below (which returns null and skips the write) rather than here, so a bad
    // model never throws mid-batch.
    super(chunk, indexName ?? '');
  }

  static async loadSearchIndexClient(): Promise<OpenSearchClient> {
    if (!cachedClient) {
      const endpoint = process.env.OPENSEARCH_ENDPOINT;
      if (!endpoint) {
        throw new Error('OPENSEARCH_ENDPOINT is not set');
      }
      cachedClient = new OpenSearchClient(endpoint, { selfHosted: true });
    }
    return cachedClient;
  }

  protected async mapDocument(chunk: IFabFileChunkDocument): Promise<SearchDocument | null> {
    if (!chunk.text || !chunk.vector || chunk.vector.length === 0 || !chunk.embeddingModel) {
      return null;
    }
    if (!selfHostVectorIndexName(chunk.embeddingModel)) {
      Logger.globalInstance.warn(`No self-host OpenSearch index registered for model ${chunk.embeddingModel}`);
      return null;
    }
    return {
      id: chunk.id,
      text: chunk.text,
      vector: chunk.vector,
      metadata: {
        fabFileId: chunk.fabFileId,
        embeddingModel: chunk.embeddingModel,
        sourceType: 'fabFileChunk',
      },
    };
  }

  /**
   * Create the model's index on first use. Without this, `indexDocument` would auto-create a
   * dynamic mapping (`vector` as plain `float`, not `knn_vector`), and every later kNN query
   * would 400 against it. Memoized per model per process - one indexExists HEAD, not one per chunk.
   */
  private static ensuredModels = new Set<string>();
  static async ensureIndexForModel(model: string): Promise<void> {
    if (this.ensuredModels.has(model)) return;
    const indexName = selfHostVectorIndexName(model);
    const dimension = getEmbeddingDimensions(model);
    if (!indexName || dimension == null) return;
    await this.ensureIndex(indexName, buildSearchIndexSettings(dimension));
    this.ensuredModels.add(model);
  }

  /** Index every embeddable chunk from a vectorize batch, one call each (self-host only, best-effort). */
  static async indexChunks(chunks: IFabFileChunkDocument[]): Promise<void> {
    const models = new Set(chunks.map(c => c.embeddingModel).filter((m): m is string => !!m));
    await Promise.all([...models].map(model => FabFileChunkSearchIndex.ensureIndexForModel(model)));
    await BaseSearchIndex.processInParallel(chunks.map(chunk => new FabFileChunkSearchIndex(chunk)));
  }

  /** Remove every OpenSearch doc for a deleted/re-chunked file, across the given model's index. */
  static async deleteByFabFileId(fabFileId: string, embeddingModel: string): Promise<void> {
    const indexName = selfHostVectorIndexName(embeddingModel);
    if (!indexName) return;
    const osClient = await this.loadSearchIndexClient();
    try {
      await osClient.deleteDocumentByQuery(indexName, {
        query: { term: { 'metadata.fabFileId': fabFileId } },
      });
    } catch (error) {
      Logger.globalInstance.warn(`Failed to delete self-host OpenSearch vectors for FabFile ${fabFileId}:`, error);
    }
  }

  // reindex() is intentionally not implemented: backfilling chunks vectorized before self-host
  // OpenSearch was enabled is a future bulk job, not part of this feature. An existing self-host
  // install that turns the flag on only gets FUTURE writes indexed; older chunks stay scan-only
  // (semanticDataLakeSearch.ts's zero-hit rebucket already degrades this gracefully to a scan).
}
