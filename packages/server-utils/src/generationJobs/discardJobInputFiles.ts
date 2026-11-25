import { storageOwnerOf, type StorageOwner } from '@bike4mind/common';
import {
  fabFileChunkRepository,
  fabFileRepository,
  sessionRepository,
  userRepository,
  withTransaction,
} from '@bike4mind/database';
import { fabFilesService } from '@bike4mind/services';
import type { Logger } from '@bike4mind/observability';
import { adjustOwnerStorageInSession } from '../s3/storageCharge';
import { getFilesStorage } from '../utils/storage/index';

/**
 * Deletes the throwaway inputs of a chat image edit (its mask, and a source copy the request made) once the batch is
 * done, as the legacy edit deleted its mask (b4m-core/services/src/llm/ImageEdit.ts). Only the requester's own files:
 * deleteFabFile would unshare a file shared with them, which is never what discarding an input means. The owner's
 * storage is refunded as DELETE /api/files/{id} does (apps/client/server/files/deleteFileForUser.ts). An id already
 * gone is skipped, so a second call is harmless; a failure is logged per file and never thrown.
 */
export async function discardJobInputFiles(
  userId: string,
  fileIds: readonly string[],
  logger: Pick<Logger, 'warn' | 'error'>
): Promise<void> {
  for (const fileId of new Set(fileIds)) {
    try {
      if (!(await fabFileRepository.findByIdAndUserId(fileId, userId))) continue;
      let refund: { owner: StorageOwner; bytes: number } | undefined;
      await fabFilesService.deleteFabFile(
        userId,
        { id: fileId },
        {
          db: {
            fabFiles: fabFileRepository,
            fabFileChunks: fabFileChunkRepository,
            users: userRepository,
            sessions: sessionRepository,
          },
          storage: getFilesStorage(),
          onDeleteComplete: async (deleted, bytes) => {
            refund = { owner: storageOwnerOf(deleted), bytes };
          },
        }
      );
      const charged = refund;
      if (charged && charged.bytes > 0) {
        await withTransaction(session => adjustOwnerStorageInSession(charged.owner, -charged.bytes, session));
      }
    } catch (error) {
      logger.warn('[imageJobs] could not delete a discarded input file', { userId, fileId, error });
    }
  }
}
