import type { IFabFileChunkRepository } from '@bike4mind/common';
import type { RetrievalIndexPort, RetrievalIndexRemoval } from './ports';

export interface OpenSearchRetrievalIndexAdapters {
  db: { fabFileChunks: Pick<IFabFileChunkRepository, 'retrievalIndexModelsByFabFileIds'> };
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
 * intentionally scope-agnostic), so this resolves it from the chunk store rather than trusting
 * FabFile.embeddingModel, which is only a file's CURRENT model and can miss chunks left behind by
 * an earlier embed (see IFabFileChunk.embeddingModel).
 *
 * Resolved PER FILE, not per batch. Pairing every file with every model seen across the batch is a
 * cross-product: a 5,000-file lake spanning two models issues 10,000 requests, half of them against
 * a model that file never used. Beyond the waste, it also widens any per-index failure from "the
 * files on that model" to "every file in the removal".
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
      const modelsByFile = await adapters.db.fabFileChunks.retrievalIndexModelsByFabFileIds(fabFileIds);
      // A file absent from the map has no chunk recording an index it was written to, so it has
      // nothing in any index - iterating the map rather than fabFileIds is what drops those no-op
      // requests. Absence is only trustworthy because the map unions index RESIDENCY with the
      // readiness stamp (see IFabFileChunk.retrievalIndexModel); on the stamp alone a file whose
      // vectorize never finished would read as absent while its documents were still live.
      const pairs = Object.entries(modelsByFile).flatMap(([fabFileId, models]) =>
        models.map(model => ({ fabFileId, model }))
      );
      await inChunks(pairs, REMOVAL_CHUNK_SIZE, ({ fabFileId, model }) =>
        adapters.searchIndex.deleteByFabFileIdOrThrow(fabFileId, model)
      );
    },
  };
}
