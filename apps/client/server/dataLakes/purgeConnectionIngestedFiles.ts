import {
  dataLakeFindingRepository,
  dataLakeRepository,
  fabFileChunkRepository,
  fabFileRepository,
  sessionRepository,
  userRepository,
} from '@bike4mind/database';
import { dataLakeService } from '@bike4mind/services';
import { FabFileChunkSearchIndex } from '@bike4mind/fab-pipeline';
import { selfHostOpenSearchEnabled } from '@bike4mind/db-core';
import type { IDataLakeDocument } from '@bike4mind/common';
import { shredMemoryForLakeTags } from '@server/dataLakes/shredMemoryForLakeTags';
import { getFilesStorage } from '@server/utils/storage';

export interface PurgeConnectionLogger {
  info: (msg: string, ...args: unknown[]) => void;
  warn: (msg: string, ...args: unknown[]) => void;
  error: (msg: string, ...args: unknown[]) => void;
}

type PurgeableConnectionFile = Parameters<typeof dataLakeService.purgeDataLakeConnectionFiles>[1][number];

/**
 * Sweep everything a just-disconnected connector connection ingested into this lake: FabFile rows,
 * their chunks, retrieval-index entries, stored objects and lake-memory beliefs - see
 * purgeDataLakeConnectionFiles. A connection-scoped subset of the lake, not the lake itself: a
 * sibling connection's files and any manually-uploaded file in the same lake are untouched.
 *
 * Used by GitHub's disconnect and revoke doors (the DELETE route and queueHandlers/githubLakeRevoke.ts);
 * Drive's purge runs in slices in queueHandlers/driveDisconnectPurge.ts. Unsliced by default; with
 * `sliceSize` it sweeps at most that many files (the finder is handed `sliceSize + 1` as its limit)
 * and reports whether any remain, so a queue consumer can re-enqueue for the rest.
 *
 * Callers resolve files with their connector's archived/deleted-blind finder, and call this AFTER
 * the connection is disabled (stops a re-claim) but BEFORE its release hard-deletes the row - unlike
 * cleanupDeletedDataLake's own release-then-sweep ordering (its step 1c), this door's sweep can
 * itself throw partway, and the row must still resolve on a retried DELETE so a failed purge can be
 * retried instead of stranding the remainder.
 *
 * Recomputes the lake's persisted fileCount/totalSizeBytes after the sweep, mirroring
 * purgeDataLakeDocument's own call - otherwise those numbers (rendered on DataLakeDiscoverPanel and
 * the public-lake browse route) drift stale after a disconnect until some unrelated batch happens
 * to recompute them.
 *
 * On failure, logs and rethrows the purge error.
 */
export async function purgeConnectionIngestedFiles(
  lake: IDataLakeDocument,
  findFiles: (limit?: number) => Promise<PurgeableConnectionFile[]>,
  opts: {
    connectionId: string;
    label: string;
    logger: PurgeConnectionLogger;
    sliceSize?: number;
  }
): Promise<{ remaining: boolean }> {
  const { connectionId, label, logger, sliceSize } = opts;
  try {
    const found = await findFiles(sliceSize === undefined ? undefined : sliceSize + 1);
    const files = sliceSize === undefined ? found : found.slice(0, sliceSize);
    await sweep(lake, files, logger);
    return { remaining: files.length < found.length };
  } catch (error) {
    logger.error(`${label}: purge failed`, { connectionId, dataLakeId: lake.id, error });
    throw error;
  }
}

async function sweep(
  lake: IDataLakeDocument,
  files: PurgeableConnectionFile[],
  logger: PurgeConnectionLogger
): Promise<void> {
  if (files.length === 0) return;
  const purgingLake = { id: lake.id, datalakeTag: lake.datalakeTag, createdByUserId: lake.createdByUserId };
  await dataLakeService.purgeDataLakeConnectionFiles(dataLakeService.lakeMembershipScope(lake), files, {
    db: {
      fabFiles: fabFileRepository,
      fabFileChunks: fabFileChunkRepository,
      users: userRepository,
      dataLakeFindings: dataLakeFindingRepository,
      sessions: sessionRepository,
    },
    // Undefined everywhere except self-host OpenSearch - Atlas's vector index lives on the
    // FabFileChunk collection itself, so the chunk delete already removes it (same wiring as the
    // phase-2 lake sweep in dataLakeCleanup.ts).
    retrievalIndex: selfHostOpenSearchEnabled()
      ? dataLakeService.openSearchRetrievalIndex({
          db: { fabFileChunks: fabFileChunkRepository },
          searchIndex: FabFileChunkSearchIndex,
        })
      : undefined,
    storage: getFilesStorage(),
    // Per-document lake-memory shred, mirroring purgeDataLakeDocument's own shredDocumentMemory
    // wiring: without it, a connection-purged document's extracted facts keep reaching live system
    // prompts through recallLakeMemory forever - the same gap the whole-lake purge already closes
    // with its own (broader-brush) shredMemory. Reads are already orphan-safe (recallLakeMemory and
    // the profile route both drop beliefs whose source file is gone), so this was a retention-only
    // gap, not a leak, but every other permanent-delete path on this lake already closes it.
    shredDocumentMemory: async ({ tagNames, fabFileId, ownerUserId }) => {
      await shredMemoryForLakeTags(tagNames, fabFileId, ownerUserId, purgingLake, { logger });
    },
    logger,
  });
  await dataLakeService.recomputeLakeStats(lake, {
    db: { dataLakes: dataLakeRepository, fabFiles: fabFileRepository },
  });
}
