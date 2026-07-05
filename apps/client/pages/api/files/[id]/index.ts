import { FileEvents, IFabFile, KnowledgeType } from '@bike4mind/common';
import {
  changeStorageSize,
  dataLakeRepository,
  fabFileChunkRepository,
  fabFileRepository,
  fileTagRepository,
  adminSettingsRepository,
  sessionRepository,
  userRepository,
  withTransaction,
  User,
} from '@bike4mind/database';
import { dataLakeService, fabFilesService } from '@bike4mind/services';
import { logEvent } from '@server/utils/analyticsLog';
import { baseApi } from '@server/middlewares/baseApi';
import { getFilesStorage } from '@server/utils/storage';
import { Request } from 'express';
import { Types } from 'mongoose';

const handler = baseApi()
  .get(async (req: Request<{}, unknown, unknown, { id: string }>, res) => {
    req.logger.updateMetadata({ userId: req.user.id, fileId: req.query.id });

    const fabFile = await fabFilesService.getFabFile(
      req.user.id,
      { id: req.query.id },
      {
        db: {
          fabFiles: fabFileRepository,
          users: userRepository,
          adminSettings: adminSettingsRepository,
        },
        storage: {
          generateSignedUrl: async (path: string, expireInSeconds: number) => {
            try {
              return await getFilesStorage().getSignedUrl(path, 'get', { expiresIn: expireInSeconds });
            } catch (error) {
              req.logger.error('Error generating signed URL:', { error, path });
              throw error;
            }
          },
        },
      }
    );

    return res.json(fabFile);
  })
  /**
   * Update FabFile by ID
   */
  .put(async (req: Request<{}, {}, Partial<IFabFile> & { fileContent: string }, { id: string }>, res) => {
    const userId = req.user.id;
    const fabFileId = req.query.id;

    req.logger.updateMetadata({ userId, fileId: fabFileId });

    // Data-lake membership is conferred by the lake's `datalake:*` meta-tag. Applying one is a
    // WRITE into that lake, so gate it with the same creator/admin check the remove path uses -
    // otherwise a read-only member could inject files via Send-to-Data-Lake.
    const candidateTagNames = [
      ...(req.body.tags?.map(t => t.name) ?? []),
      ...(req.body.primaryTag ? [req.body.primaryTag] : []),
    ];
    await dataLakeService.assertCanWriteDataLakeTags({ userId, isAdmin: !!req.user.isAdmin }, candidateTagNames, {
      db: { dataLakes: dataLakeRepository },
    });

    const updatedFabFile = await withTransaction(async () => {
      try {
        return await fabFilesService.updateFabFile(
          req.user,
          {
            id: fabFileId,
            type: req.body.type as KnowledgeType,
            fileName: req.body.fileName as string,
            mimeType: req.body.mimeType as string,
            fileContent: req.body.fileContent,
            system: req.body.system,
            systemPriority: req.body.systemPriority,
            sessionId: req.body.sessionId,
            notes: req.body.notes,
            // Pass through null so "unset primary" clears the field; ?? undefined
            // would coalesce null to undefined and get dropped from the $set.
            primaryTag: req.body.primaryTag,
            tags: req.body.tags,
            error: req.body.error,
          },
          {
            db: { fabFiles: fabFileRepository },
            storage: {
              upload: (filepath, content, option) => {
                return getFilesStorage().upload(content, filepath, option);
              },
              generateSignedUrl: (path: string, expireInSeconds: number) =>
                getFilesStorage().getSignedUrl(path, undefined, { expiresIn: expireInSeconds }),
            },
          }
        );
      } catch (error) {
        req.logger.error('Error updating fab file:', { error, fileId: fabFileId });
        throw error;
      }
    });

    await logEvent(
      {
        userId,
        type: FileEvents.UPDATE_FILE,
        metadata: { fileId: fabFileId, fileContent: updatedFabFile.filePath ?? '' },
      },
      { ability: req.ability }
    );

    return res.json(updatedFabFile);
  })
  /**
   * Delete FabFile by ID
   */
  .delete(async (req: Request<{}, {}, {}, { id: string }>, res) => {
    const userId = req.user.id;
    const fabFileId = req.query.id;

    req.logger.updateMetadata({ userId, fileId: fabFileId });

    if (!Types.ObjectId.isValid(fabFileId) || new Types.ObjectId(fabFileId).toString() !== fabFileId) {
      return res.status(404).json({ msg: 'File not found' });
    }

    // Only decrement tag counts for owned files (shared file "delete" = unshare, not removal)
    const fabFile = await fabFileRepository.findById(fabFileId);
    const isOwned = fabFile?.userId === userId;
    if (isOwned && fabFile?.tags?.length) {
      for (const tag of fabFile.tags) {
        try {
          if (tag?.name) {
            await fileTagRepository.incrementFileCountBy({ name: tag.name, userId }, -1);
          }
        } catch (tagError) {
          req.logger.error('Error updating tag count during single file delete:', { tagError, tag });
        }
      }
    }

    let sizeToDeduct = 0;

    let deleteAction: string = 'not_found';

    await withTransaction(async session => {
      const result = await fabFilesService.deleteFabFile(
        userId,
        { id: fabFileId },
        {
          db: {
            fabFiles: fabFileRepository,
            users: userRepository,
            sessions: sessionRepository,
            fabFileChunks: fabFileChunkRepository,
          },
          storage: getFilesStorage(),
          onDeleteComplete: async (_fabFile, size) => {
            sizeToDeduct = size;
          },
        }
      );

      deleteAction = result.action;

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

    return res.json({ msg: 'Fab file deleted', action: deleteAction });
  });

export const config = {
  api: {
    bodyParser: { sizeLimit: '10mb' },
    externalResolver: true,
  },
};

export default handler;
