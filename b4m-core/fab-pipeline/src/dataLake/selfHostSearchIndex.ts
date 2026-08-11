import type { IFabFileChunkDocument } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { BaseSearchIndex } from './BaseSearchIndex';
import { OpenSearchClient, isIndexAlreadyExistsError } from './opensearchClient';
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
  constructor(
    chunk: IFabFileChunkDocument,
    private onIndexFailure?: (chunk: IFabFileChunkDocument) => void
  ) {
    const indexName = chunk.embeddingModel ? selfHostVectorIndexName(chunk.embeddingModel) : null;
    // BaseSearchIndex requires a name at construction time; an unresolvable name is caught in
    // mapDocument below (which returns null and skips the write) rather than here, so a bad
    // model never throws mid-batch.
    super(chunk, indexName ?? '');
  }

  /**
   * Overrides the base's throw-on-failure contract: a chunk failure here must not also stop
   * `processInParallel`'s runner from picking up its NEXT chunk (a throw from `asyncFn` ends
   * that runner's loop - see @bike4mind/common's `parallelLimit`), and `indexChunks` below needs
   * to know WHICH file to fail closed, not just that something somewhere failed.
   */
  async addDocument(): Promise<SearchDocument | null> {
    try {
      return await super.addDocument();
    } catch {
      // Already logged by the base class. Swallow here so the batch keeps going.
      this.onIndexFailure?.(this.rawData as IFabFileChunkDocument);
      return null;
    }
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
    try {
      await this.ensureIndex(indexName, buildSearchIndexSettings(dimension));
    } catch (error) {
      // Two concurrent indexChunks batches for a model with no index yet both see
      // ensuredModels.has(model) === false and both reach createIndex - the loser gets this
      // error, and the index exists now regardless of who created it. Without this guard the
      // error propagates out of indexChunks' Promise.all and skips EVERY chunk in the batch,
      // not just the ones for this model.
      if (!isIndexAlreadyExistsError(error as Error)) throw error;
    }
    this.ensuredModels.add(model);
  }

  /** Index every embeddable chunk from a vectorize batch, one call each (self-host only, best-effort). */
  static async indexChunks(chunks: IFabFileChunkDocument[]): Promise<void> {
    const models = new Set(chunks.map(c => c.embeddingModel).filter((m): m is string => !!m));
    await Promise.all([...models].map(model => FabFileChunkSearchIndex.ensureIndexForModel(model)));

    const failedChunks: IFabFileChunkDocument[] = [];
    await BaseSearchIndex.processInParallel(
      chunks.map(chunk => new FabFileChunkSearchIndex(chunk, failed => failedChunks.push(failed)))
    );

    if (failedChunks.length === 0) return;

    // Fail CLOSED per BATCH, never per file: `indexChunks` runs once per vectorize MESSAGE
    // (fabFileVectorize.ts), and a file can span several messages. Deleting by fabFileId alone
    // would also destroy an EARLIER or LATER batch's correctly-indexed chunks for the same file -
    // a real regression a fix here once shipped. Scoping to only THIS call's own chunk ids means
    // a failure here can only ever undo what this same call wrote; it can never reach a sibling
    // batch's docs. The failed chunk's content itself becomes the same accepted "no backfill" gap
    // SELF_HOST.md already documents, not a destroyed-good-data regression.
    const failedKeys = new Set(
      failedChunks.filter(c => c.fabFileId && c.embeddingModel).map(c => `${c.fabFileId} ${c.embeddingModel}`)
    );
    const idsByFileModel = new Map<string, { fabFileId: string; embeddingModel: string; ids: string[] }>();
    for (const chunk of chunks) {
      if (!chunk.fabFileId || !chunk.embeddingModel) continue;
      const key = `${chunk.fabFileId} ${chunk.embeddingModel}`;
      if (!failedKeys.has(key)) continue;
      if (!idsByFileModel.has(key)) {
        idsByFileModel.set(key, { fabFileId: chunk.fabFileId, embeddingModel: chunk.embeddingModel, ids: [] });
      }
      idsByFileModel.get(key)!.ids.push(chunk.id);
    }
    await Promise.all(
      [...idsByFileModel.values()].map(({ fabFileId, embeddingModel, ids }) => {
        Logger.globalInstance.warn(
          `Chunk indexing failed for FabFile ${fabFileId} (model ${embeddingModel}) - removing this batch's own OpenSearch docs (not the whole file) so its content falls back to scan`
        );
        return FabFileChunkSearchIndex.deleteByChunkIds(embeddingModel, ids);
      })
    );
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

  /**
   * Remove specific chunk docs by id (id === chunk id, see mapDocument) from a single model's
   * index. Called from `indexChunks` to clean up a failed batch's own docs.
   *
   * Fail-open, matching `deleteByFabFileId`, and left that way deliberately - but note the
   * residual: the most likely cause of THIS delete failing is the same cluster outage that
   * failed the original write, so exactly when the cleanup matters most, it is least likely to
   * run. There is no retry here; a later `reindex()`/backfill job is the only repair path once
   * one exists (see the note at the bottom of this file).
   */
  static async deleteByChunkIds(embeddingModel: string, chunkIds: string[]): Promise<void> {
    if (chunkIds.length === 0) return;
    const indexName = selfHostVectorIndexName(embeddingModel);
    if (!indexName) return;
    const osClient = await this.loadSearchIndexClient();
    try {
      await osClient.deleteDocumentByQuery(indexName, { query: { ids: { values: chunkIds } } });
    } catch (error) {
      Logger.globalInstance.warn(`Failed to delete self-host OpenSearch chunk docs ${chunkIds.join(', ')}:`, error);
    }
  }

  // reindex() is intentionally not implemented: backfilling chunks vectorized before self-host
  // OpenSearch was enabled is a future bulk job, not part of this feature. An existing self-host
  // install that turns the flag on only gets FUTURE writes indexed; older chunks stay scan-only
  // (semanticDataLakeSearch.ts's zero-hit rebucket already degrades this gracefully to a scan).
}
