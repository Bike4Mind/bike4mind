import type { IFabFileChunkRepository } from '@bike4mind/common';
import type { RetrievalIndexPort, RetrievalIndexRemoval } from './ports';

export interface OpenSearchRetrievalIndexAdapters {
  db: { fabFileChunks: Pick<IFabFileChunkRepository, 'distinctEmbeddingModelsByFabFileIds'> };
  searchIndex: { deleteByFabFileIdOrThrow: (fabFileId: string, embeddingModel: string) => Promise<void> };
}

/** Bounds peak concurrency against OpenSearch - matches cleanupDeletedDataLake.ts's own fan-outs. */
const REMOVAL_CHUNK_SIZE = 20;

/** Run `fn` over `items` in sequential slices of `size` - a rejection propagates immediately, unlike `Promise.all` over the whole set or a `parallelLimit`-style runner (which settles every lane and never rejects). */
async function inChunks<T>(items: T[], size: number, fn: (item: T) => Promise<unknown>): Promise<void> {
  for (let i = 0; i < items.length; i += size) {
    await Promise.all(items.slice(i, i + size).map(fn));
  }
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
 *
 * Deliberately failure-neutral: uses `deleteByFabFileIdOrThrow`, NOT the fail-open
 * `deleteByFabFileId` the write/delete paths use directly. This port backs both
 * `bestEffortIndexRemove` (archive/delete, which wraps the whole call and logs) AND
 * `strictIndexRemove` (the phase-2 purge, which does NOT catch) - baking in fail-open here would
 * silently break the purge's abort-on-failure contract (see ports.ts), letting it hard-delete
 * Mongo rows an OpenSearch removal never actually completed. The chunked (not unbounded
 * `Promise.all`) fan-out is for the same reason: the purge is the one sweep step that must not
 * fail, so it gets the same bounded-concurrency discipline as every other step in
 * cleanupDeletedDataLake.ts, not a single unbounded burst against the cluster.
 */
export function openSearchRetrievalIndex(adapters: OpenSearchRetrievalIndexAdapters): RetrievalIndexPort {
  return {
    async removeForDataLake({ fabFileIds }: RetrievalIndexRemoval): Promise<void> {
      if (fabFileIds.length === 0) return;
      const models = await adapters.db.fabFileChunks.distinctEmbeddingModelsByFabFileIds(fabFileIds);
      const pairs = fabFileIds.flatMap(fabFileId => models.map(model => ({ fabFileId, model })));
      await inChunks(pairs, REMOVAL_CHUNK_SIZE, ({ fabFileId, model }) =>
        adapters.searchIndex.deleteByFabFileIdOrThrow(fabFileId, model)
      );
    },
  };
}
