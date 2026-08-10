import type { IFabFileChunkRepository } from '@bike4mind/common';
import type { RetrievalIndexPort, RetrievalIndexRemoval } from './ports';

export interface OpenSearchRetrievalIndexAdapters {
  db: { fabFileChunks: Pick<IFabFileChunkRepository, 'distinctEmbeddingModelsByFabFileIds'> };
  searchIndex: { deleteByFabFileId: (fabFileId: string, embeddingModel: string) => Promise<void> };
}

/**
 * Concrete `RetrievalIndexPort` for self-host OpenSearch - the first real implementation of this
 * port (every lifecycle door has always taken `retrievalIndex: undefined` until now). Atlas needs
 * no implementation of its own: its vector index lives ON the FabFileChunk collection itself, so
 * `db.fabFileChunks.deleteManyByFabFileId` already removes it there. OpenSearch is a genuinely
 * separate store, so its docs need their own removal - and per-model indexes mean a removal must
 * resolve which model(s) each file's chunks actually used before it knows which index to hit.
 *
 * `RetrievalIndexRemoval` carries only fabFileIds, not embeddingModel (see ports.ts - the port is
 * intentionally scope-agnostic), so this resolves it per-batch from the chunk store rather than
 * trusting FabFile.embeddingModel, which is only a file's CURRENT model and can miss chunks left
 * behind by an earlier embed (see IFabFileChunk.embeddingModel).
 */
export function openSearchRetrievalIndex(adapters: OpenSearchRetrievalIndexAdapters): RetrievalIndexPort {
  return {
    async removeForDataLake({ fabFileIds }: RetrievalIndexRemoval): Promise<void> {
      if (fabFileIds.length === 0) return;
      const models = await adapters.db.fabFileChunks.distinctEmbeddingModelsByFabFileIds(fabFileIds);
      // Every (file, model) pair rather than a per-model bulk query: deleteByFabFileId is already
      // the fail-open, per-file primitive the write/delete paths use, so reusing it here keeps
      // one removal semantics across the whole feature instead of introducing a second one.
      await Promise.all(
        fabFileIds.flatMap(fabFileId => models.map(model => adapters.searchIndex.deleteByFabFileId(fabFileId, model)))
      );
    },
  };
}
