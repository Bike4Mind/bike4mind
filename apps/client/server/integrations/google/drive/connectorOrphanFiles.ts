import type { IFabFileDocument } from '@bike4mind/common';
import {
  dataLakeRepository,
  fabFileChunkRepository,
  fabFileRepository,
  sessionRepository,
  userRepository,
} from '@bike4mind/database';
import { dataLakeService, fabFilesService } from '@bike4mind/services';
import { FabFileChunkSearchIndex } from '@bike4mind/fab-pipeline';
import { selfHostOpenSearchEnabled } from '@bike4mind/db-core';
import { getFilesStorage } from '@server/utils/storage';
import { evaluateConnectorCopyDeletion } from './connectorCopyGate';

/** The logger shape both the queue handler and the API route already carry. */
export interface OrphanSweepLogger {
  info: (msg: string, ...args: unknown[]) => void;
  warn: (msg: string, ...args: unknown[]) => void;
  error: (msg: string, ...args: unknown[]) => void;
}

/** A live orphan the gate cleared for permanent deletion, with the owner to run the delete as. */
export interface DeletableDriveOrphan {
  orphan: IFabFileDocument;
  ownerId: string;
}

/**
 * The connector-minted FabFiles a Drive connection left UNPICKED-but-alive: live, non-member rows
 * still carrying its `driveConnectionId` (see `findLiveNonMembersByDriveConnectionId`) that the
 * shared gate clears for deletion. A copy a share, another lake, or a missing owner still claims is
 * NOT returned - it stays alive, exactly as it does on the ingest retire path.
 *
 * Both the GET route (to fold the count it would remove into the confirmation number) and the
 * queued disconnect purge (to remove them) call this, so the two can never disagree.
 */
export const listDeletableDriveOrphans = async (
  lake: { id: string; datalakeTag: string },
  driveConnectionId: string,
  logger: OrphanSweepLogger
): Promise<DeletableDriveOrphan[]> => {
  const orphans = await fabFileRepository.findLiveNonMembersByDriveConnectionId(driveConnectionId, lake.datalakeTag);
  if (orphans.length === 0) return [];

  // Resolved once for the whole sweep, matching the ingest's memoized lookup - the prefix arm is
  // owner-anchored, so this is every lake any orphan's owner created.
  const candidateLakes = await dataLakeService.loadPrefixArmCandidateLakes(
    orphans.map(orphan => orphan.userId),
    { db: { dataLakes: dataLakeRepository } }
  );

  // Resolve owners once, and treat a deterministic missing-owner as "keep", not a failure.
  const ownerExists = new Map<string, boolean>();
  const ownerStillExists = async (ownerId: string) => {
    const cached = ownerExists.get(ownerId);
    if (cached !== undefined) return cached;
    const exists = !!(await userRepository.findById(ownerId));
    ownerExists.set(ownerId, exists);
    return exists;
  };

  const deletable: DeletableDriveOrphan[] = [];
  for (const orphan of orphans) {
    const verdict = await evaluateConnectorCopyDeletion(orphan, lake, {
      adapters: { db: { dataLakes: dataLakeRepository }, candidateLakes },
      ownerStillExists,
    });
    if (!verdict.deletable) {
      logger.info('[driveOrphanSweep] orphan kept; not deletable', {
        fabFileId: orphan.id,
        driveConnectionId,
        reason: verdict.reason,
        ...verdict.detail,
      });
      continue;
    }
    deletable.push({ orphan, ownerId: verdict.ownerId });
  }
  return deletable;
};

/**
 * Permanently delete the gate-cleared orphans, as each row's OWN owner (never the disconnecting
 * user - a reconnect re-stamps `connectedBy`), through `deleteFabFile` so the chunks, personal
 * search docs, notebook links, stored object and counted storage all go with the row. Reclaimed
 * bytes are refunded per owner in a `finally`, so a failure part way still gives back what already
 * committed.
 *
 * `deleteFabFile`, not the lake-scoped `purgeDataLakeConnectionFiles`: these rows are no longer lake
 * members, so the membership scope and the lake-scoped retrieval-index removal do not describe them.
 */
export const deleteDriveOrphans = async (orphans: DeletableDriveOrphan[], logger: OrphanSweepLogger): Promise<void> => {
  if (orphans.length === 0) return;

  const storage = getFilesStorage();
  const searchIndex = selfHostOpenSearchEnabled() ? FabFileChunkSearchIndex : undefined;
  const swept: { id: string; userId: string; fileSize: number }[] = [];

  try {
    for (const { orphan, ownerId } of orphans) {
      const { action } = await fabFilesService.deleteFabFile(
        ownerId,
        { id: orphan.id },
        {
          db: {
            fabFiles: fabFileRepository,
            fabFileChunks: fabFileChunkRepository,
            users: userRepository,
            sessions: sessionRepository,
            dataLakes: dataLakeRepository,
          },
          storage,
          searchIndex,
          logger,
          origin: 'connector',
          onDeleteComplete: async (fabFile, sizeToDeduct) => {
            swept.push({ id: fabFile.id, userId: ownerId, fileSize: sizeToDeduct });
          },
        }
      );
      if (action !== 'deleted') {
        logger.warn('[driveOrphanSweep] orphan could not be deleted; left in place', {
          fabFileId: orphan.id,
          ownerId,
          action,
        });
      }
    }
  } finally {
    await dataLakeService.bestEffortAdjustOwnerStorage(
      userRepository,
      dataLakeService.groupStorageDeltaByOwner(swept, -1),
      logger
    );
  }
};
