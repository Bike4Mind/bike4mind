import { baseApi } from '@server/middlewares/baseApi';
import { fabFilesService } from '@bike4mind/services';
import {
  dataLakeRepository,
  fabFileChunkRepository,
  fabFileRepository,
  fileTagRepository,
  projectRepository,
  sessionRepository,
  userRepository,
  withTransaction,
} from '@bike4mind/database';
import { FabFileChunkSearchIndex } from '@bike4mind/fab-pipeline';
import { selfHostOpenSearchEnabled } from '@bike4mind/db-core';
import { recomputeStatsForLakeTags } from '@bike4mind/server-utils/dataLakes/recomputeStatsForLakeTags';
import { lakeConfigAuditPrincipal } from '@server/dataLakes/lakeConfigAuditPrincipal';
import { lakeMembershipAuditDb } from '@bike4mind/server-utils/dataLakes/lakeMembershipAuditDb';
import { getFilesStorage } from '@bike4mind/server-utils/utils/storage/index';
import { getGeneratedCopyStore } from '@server/files/generatedCopyStore';
import { adjustOwnerStorageInSession } from '@bike4mind/server-utils/s3/storageCharge';
import { logEvent } from '@server/utils/analyticsLog';
import { FileEvents, storageOwnerOf, sumStorageDeltaByOwner, type StorageOwner } from '@bike4mind/common';
import { Request } from 'express';
import { z } from 'zod';
import { FILES_WRITE_SCOPES } from '@server/files/fileScopes';
const BulkDeleteFilesSchema = z.object({
  fileIds: z.array(z.string()).min(1, 'At least one file ID is required'),
});

type BulkDeleteFilesRequest = z.infer<typeof BulkDeleteFilesSchema>;

const handler = baseApi({ requiredScopes: FILES_WRITE_SCOPES })
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

    // Per owner: a batch can span personal files and files owned by an org.
    const refunds: Array<{ owner: StorageOwner; bytes: number }> = [];
    // Only from deletes whose transaction COMMITTED - see the merge after withTransaction below.
    const committedReferences: fabFilesService.DeletedFileReferences[] = [];
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

        // Returned out of the callback, so only an attempt that COMMITTED yields references: a
        // rolled-back or retried attempt's must never be pruned - the file is still live.
        const attemptReferences = await withTransaction(async session => {
          const result = await fabFilesService.deleteFabFile(
            userId,
            { id: fileId },
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
              generatedCopies: getGeneratedCopyStore(),
              onDeleteComplete: async (deleted, sizeToDeduct) => {
                refunds.push({ owner: storageOwnerOf(deleted), bytes: -sizeToDeduct });
              },
              searchIndex: selfHostOpenSearchEnabled() ? FabFileChunkSearchIndex : undefined,
              logger: req.logger,
              auditPrincipal: lakeConfigAuditPrincipal(req.user, req.apiKeyInfo),
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
          return result.references;
        });
        if (attemptReferences) committedReferences.push(attemptReferences);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        req.logger.error('Error deleting file in bulk operation:', {
          error: errorMessage,
        });
        results.failed.push({ id: fileId, error: errorMessage });
      }
    }

    // One system-file/project unlink per group of files with the SAME holders, after every
    // transaction has resolved and outside all of them (see cleanUpDeletedFileReferences). Grouped
    // rather than folded across the batch: a batch can mix a deleted file with a merely unshared
    // one, and folding them would pull the unshared file from its other recipients. Best-effort:
    // the files are already deleted, so nothing here may change the response.
    try {
      for (const references of fabFilesService.groupDeletedFileReferences(committedReferences)) {
        await fabFilesService.cleanUpDeletedFileReferences(
          references,
          { users: userRepository, projects: projectRepository },
          req.logger
        );
      }
    } catch (error) {
      req.logger.warn('Bulk delete: failed to unlink references to deleted files', { error });
    }

    // One refund per owner after all deletions; one owner's failure does not skip the others.
    for (const { owner, bytes } of sumStorageDeltaByOwner(refunds)) {
      try {
        await withTransaction(session => adjustOwnerStorageInSession(owner, bytes, session));
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        req.logger.error('Error updating owner storage size after bulk delete:', {
          error: errorMessage,
          owner,
          totalSizeToDeduct: -bytes,
        });
      }
    }

    // After every delete transaction has committed, so the aggregation sees each `deletedAt`.
    if (deletedFileTagNames.length > 0) {
      await recomputeStatsForLakeTags(deletedFileTagNames, {
        logger: req.logger,
        actor: {
          userId: req.user.id,
          isAdmin: !!req.user.isAdmin,
          auditPrincipal: lakeConfigAuditPrincipal(req.user, req.apiKeyInfo),
        },
      });
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
