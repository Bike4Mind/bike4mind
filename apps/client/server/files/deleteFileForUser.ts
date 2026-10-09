import { FileEvents } from '@bike4mind/common';
import {
  changeStorageSize,
  dataLakeRepository,
  fabFileChunkRepository,
  fabFileRepository,
  fileTagRepository,
  sessionRepository,
  userRepository,
  withTransaction,
  User,
} from '@bike4mind/database';
import { fabFilesService } from '@bike4mind/services';
import { FabFileChunkSearchIndex } from '@bike4mind/fab-pipeline';
import { selfHostOpenSearchEnabled } from '@bike4mind/db-core';
import { logEvent } from '@server/utils/analyticsLog';
import { recomputeStatsForLakeTags } from '@server/dataLakes/recomputeStatsForLakeTags';
import { lakeConfigAuditPrincipal } from '@server/dataLakes/lakeConfigAuditPrincipal';
import { lakeMembershipAuditDb } from '@server/dataLakes/lakeMembershipAuditDb';
import { getFilesStorage } from '@server/utils/storage';
import type { Request } from 'express';

/**
 * Deletes a FabFile for the caller - or, on a file shared with them, removes their access - and runs
 * every side effect that goes with it: tag activity, analytics, storage deduction and lake stats.
 * Returns deleteFabFile's action; mapping it to a status is the caller's job. `fabFileId` must
 * already be a valid ObjectId.
 *
 * Shared by the SPA-internal DELETE /api/files/{id} and the public DELETE /api/v1/files/{id}, so
 * the two doors cannot drift apart.
 */
export async function deleteFileForUser(req: Request, fabFileId: string) {
  const userId = req.user.id;

  // Only touch tag activity for owned files (shared file "delete" = unshare, not removal)
  const fabFile = await fabFileRepository.findById(fabFileId);
  const isOwned = fabFile?.userId === userId;
  if (isOwned && fabFile?.tags?.length) {
    for (const tag of fabFile.tags) {
      try {
        if (tag?.name) {
          await fileTagRepository.touchLastActivityBy({ name: tag.name, userId });
        }
      } catch (tagError) {
        req.logger.error('Error touching tag activity during single file delete:', { tagError, tag });
      }
    }
  }

  let sizeToDeduct = 0;

  const deleteAction = await withTransaction(async session => {
    const result = await fabFilesService.deleteFabFile(
      userId,
      { id: fabFileId },
      {
        db: {
          fabFiles: fabFileRepository,
          users: userRepository,
          sessions: sessionRepository,
          fabFileChunks: fabFileChunkRepository,
          dataLakes: dataLakeRepository,
          ...lakeMembershipAuditDb,
        },
        storage: getFilesStorage(),
        onDeleteComplete: async (_fabFile, size) => {
          sizeToDeduct = size;
        },
        searchIndex: selfHostOpenSearchEnabled() ? FabFileChunkSearchIndex : undefined,
        logger: req.logger,
        // Both doors accept a `b4m_live_` key, and the resulting 'removed' rows must name the key,
        // not the human it acts for.
        auditPrincipal: lakeConfigAuditPrincipal(req.user, req.apiKeyInfo),
      }
    );

    if (result.action === 'deleted') {
      await logEvent(
        { userId, type: FileEvents.DELETE_FILE, metadata: { fileId: fabFileId } },
        { ability: req.ability, session }
      );
    } else if (result.action === 'unshared') {
      await logEvent(
        {
          userId,
          type: FileEvents.UNSHARE_FILE,
          metadata: { fileId: fabFileId, ownerId: result.fabFile?.userId ?? '' },
        },
        { ability: req.ability, session }
      );
    }

    return result.action;
  });

  // Deduct storage size after successful deletion
  if (sizeToDeduct > 0) {
    try {
      await withTransaction(async session => {
        const user = await User.findById(userId).session(session);
        if (user) {
          await changeStorageSize(user, -sizeToDeduct);
          await user.save({ session });
        }
      });
    } catch (error) {
      req.logger.error('Error updating user storage size after single file delete:', {
        error: error instanceof Error ? error.message : 'Unknown error',
        sizeToDeduct,
      });
    }
  }

  // After the transaction, so the aggregation sees the committed `deletedAt`. The shared helper
  // also backs bulk-delete; see it for why only the 'deleted' outcome moves lake membership.
  if (deleteAction === 'deleted') {
    await recomputeStatsForLakeTags(
      (fabFile?.tags ?? []).map(tag => tag?.name),
      {
        logger: req.logger,
        actor: {
          userId: req.user.id,
          isAdmin: !!req.user.isAdmin,
          auditPrincipal: lakeConfigAuditPrincipal(req.user, req.apiKeyInfo),
        },
      }
    );
  }

  return deleteAction;
}
