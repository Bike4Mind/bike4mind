import { baseApi } from '@server/middlewares/baseApi';
import { fabFilesService } from '@bike4mind/services';
import {
  changeStorageSize,
  fabFileChunkRepository,
  fabFileRepository,
  fileTagRepository,
  sessionRepository,
  userRepository,
  withTransaction,
} from '@bike4mind/database';
import { recomputeStatsForDeletedFiles } from '@server/dataLakes/recomputeStatsForDeletedFiles';
import { getFilesStorage } from '@server/utils/storage';
import { logEvent } from '@server/utils/analyticsLog';
import { FileEvents } from '@bike4mind/common';
import { Request } from 'express';
import { z } from 'zod';
import { User } from '@bike4mind/database';
const BulkDeleteFilesSchema = z.object({
  fileIds: z.array(z.string()).min(1, 'At least one file ID is required'),
});

type BulkDeleteFilesRequest = z.infer<typeof BulkDeleteFilesSchema>;

const handler = baseApi()
  /**
   * Bulk delete files by IDs
   */
  .delete(async (req: Request<{}, {}, BulkDeleteFilesRequest>, res) => {
    const { fileIds } = BulkDeleteFilesSchema.parse(req.body);
    const userId = req.user.id;

    req.logger.updateMetadata({
      userId,
      fileIds,
    });

    const results = {
      deleted: [] as string[],
      unshared: [] as string[],
      notFound: [] as string[],
      failed: [] as { id: string; error: string }[],
    };

    let totalSizeToDeduct = 0;
    // Collected across the whole batch and recomputed once at the end, so deleting N files out of
    // one lake costs one aggregation rather than N identical ones.
    const deletedFileTagNames: (string | undefined)[] = [];

    // Process each file deletion sequentially
    for (const fileId of fileIds) {
      try {
        // Only for owned files - a shared file "delete" is an unshare, which changes nothing about
        // the actor's own tags.
        const fabFile = await fabFileRepository.findById(fileId);
        const isOwned = fabFile?.userId === userId;

        if (isOwned && fabFile && fabFile.tags && fabFile.tags.length > 0) {
          for (const tag of fabFile.tags) {
            try {
              if (tag && tag.name) {
                await fileTagRepository.touchLastActivityBy({ name: tag.name, userId });
              }
            } catch (tagError) {
              req.logger.error('Error touching tag activity during bulk delete:', {
                tagError,
                tag,
              });
            }
          }
        }

        await withTransaction(async session => {
          const result = await fabFilesService.deleteFabFile(
            userId,
            { id: fileId },
            {
              db: {
                fabFiles: fabFileRepository,
                users: userRepository,
                sessions: sessionRepository,
                fabFileChunks: fabFileChunkRepository,
              },
              storage: getFilesStorage(),
              onDeleteComplete: async (_fabFile, sizeToDeduct) => {
                totalSizeToDeduct += sizeToDeduct;
              },
            }
          );

          if (result.action === 'deleted') {
            await logEvent(
              { userId, type: FileEvents.DELETE_FILE, metadata: { fileId } },
              { ability: req.ability, session }
            );
            results.deleted.push(fileId);
            // Read off the pre-delete row: this is a soft delete, so `tags` survives, but the
            // file has already dropped out of every lake's membership scope.
            deletedFileTagNames.push(...(fabFile?.tags ?? []).map(tag => tag?.name));
          } else if (result.action === 'unshared') {
            await logEvent(
              {
                userId,
                type: FileEvents.UNSHARE_FILE,
                metadata: { fileId, ownerId: result.fabFile?.userId ?? '' },
              },
              { ability: req.ability, session }
            );
            results.unshared.push(fileId);
          } else if (fabFilesService.toPublicDeleteAction(result.action) === 'not_found') {
            results.notFound.push(fileId);
          }
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        req.logger.error('Error deleting file in bulk operation:', {
          error: errorMessage,
        });
        results.failed.push({ id: fileId, error: errorMessage });
      }
    }

    // Update user storage size once after all deletions
    if (totalSizeToDeduct > 0) {
      try {
        await withTransaction(async session => {
          const user = await User.findById(userId).session(session);
          if (user) {
            await changeStorageSize(user, -totalSizeToDeduct);
            await user.save({ session });
          }
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        req.logger.error('Error updating user storage size after bulk delete:', {
          error: errorMessage,
          totalSizeToDeduct,
        });
      }
    }

    // After every delete transaction has committed, so the aggregation sees each `deletedAt`.
    if (deletedFileTagNames.length > 0) {
      await recomputeStatsForDeletedFiles(deletedFileTagNames, { logger: req.logger });
    }

    const parts: string[] = [];
    if (results.deleted.length > 0) parts.push(`Deleted ${results.deleted.length} file(s)`);
    if (results.unshared.length > 0) parts.push(`Removed ${results.unshared.length} shared file(s) from your library`);
    if (results.notFound.length > 0) parts.push(`${results.notFound.length} file(s) not found`);
    if (results.failed.length > 0) parts.push(`Failed to process ${results.failed.length} file(s)`);
    // Every id lands in exactly one bucket above and the schema requires at least one id, so
    // `parts` is never empty.
    const message = parts.join(', ');

    return res.json({
      message,
      results,
    });
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
