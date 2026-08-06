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
import { NotFoundError } from '@bike4mind/utils';
import { logEvent } from '@server/utils/analyticsLog';
import { baseApi } from '@server/middlewares/baseApi';
import { findLakeAccessibleFabFile } from '@server/dataLakes';
import { recomputeStatsForDeletedFiles } from '@server/dataLakes/recomputeStatsForDeletedFiles';
import { getFilesStorage } from '@server/utils/storage';
import { Request } from 'express';
import { Types } from 'mongoose';

const handler = baseApi()
  .get(async (req: Request<{}, unknown, unknown, { id: string }>, res) => {
    req.logger.updateMetadata({ userId: req.user.id, fileId: req.query.id });

    const adapter = {
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
    };

    try {
      const fabFile = await fabFilesService.getFabFile(req.user.id, { id: req.query.id }, adapter);
      return res.json(fabFile);
    } catch (error) {
      if (!(error instanceof NotFoundError)) throw error;
      // Fallback: data-lake files are authorized by lake tag/prefix, NOT by per-file ACL.
      // Curated/shared lake articles (e.g. OptiHashi's opti-knowledge) are owned by a curator,
      // so getFabFile 404s for entitled non-owner users. Re-authorize via the SAME lake gate the
      // browse endpoints use and, if granted, mint a fresh signed URL through the same path so
      // the shared file viewer (KnowledgeModal) can render it. (#836)
      const lakeFile = await findLakeAccessibleFabFile(req, req.query.id);
      if (!lakeFile) throw error; // not lake-accessible either - preserve the original 404
      const fabFile = await fabFilesService.generateSignedUrl(lakeFile, adapter);
      return res.json(fabFile);
    }
  })
  /**
   * Update FabFile by ID
   */
  .put(async (req: Request<{}, {}, Partial<IFabFile> & { fileContent: string }, { id: string }>, res) => {
    const userId = req.user.id;
    const fabFileId = req.query.id;

    req.logger.updateMetadata({ userId, fileId: fabFileId });

    // Same guard the DELETE branch below carries. The round trip matters on top of isValid():
    // isValid() also accepts any 12-character string, which then coerces to an unrelated id.
    if (!Types.ObjectId.isValid(fabFileId) || new Types.ObjectId(fabFileId).toString() !== fabFileId) {
      return res.status(404).json({ msg: 'File not found' });
    }

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
            db: { fabFiles: fabFileRepository, dataLakes: dataLakeRepository },
            logger: req.logger,
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
          },
          storage: getFilesStorage(),
          onDeleteComplete: async (_fabFile, size) => {
            sizeToDeduct = size;
          },
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
      await recomputeStatsForDeletedFiles(
        (fabFile?.tags ?? []).map(tag => tag?.name),
        { logger: req.logger }
      );
    }

    return res.json({
      msg: 'Fab file deleted',
      action: fabFilesService.toPublicDeleteAction(deleteAction),
    });
  });

export const config = {
  api: {
    bodyParser: { sizeLimit: '10mb' },
    externalResolver: true,
  },
};

export default handler;
