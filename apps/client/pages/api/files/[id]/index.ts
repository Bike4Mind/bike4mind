import { FileEvents, IFabFile, isDatalakeMetaTag, KnowledgeType } from '@bike4mind/common';
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

    // Mirrors the DELETE branch below: the stored-tag read runs before the service's own
    // validation, so a garbage id has to 404 here rather than surface as a CastError.
    if (!Types.ObjectId.isValid(fabFileId) || new Types.ObjectId(fabFileId).toString() !== fabFileId) {
      return res.status(404).json({ msg: 'File not found' });
    }

    const { updatedFabFile, affectedLakes } = await withTransaction(async () => {
      // Read the tags this write REPLACES through the accessor updateFabFile itself uses, so an
      // inaccessible file yields no stored tags and still 404s from the service - an unscoped read
      // would turn the gate below into a file-existence oracle. Inside the transaction so
      // authorization and the write decide on one snapshot: db-core enables mongoose's
      // `transactionAsyncLocalStorage`, so calls in here join the ambient session without being
      // handed it (see withTransaction's own note) - the DELETE branch below passes `session`
      // explicitly only because logEvent takes it as an option.
      const storedFile = await fabFileRepository.shareable.findAccessibleById(req.user, fabFileId);
      const storedTagNames = (storedFile?.tags ?? []).map(tag => tag?.name);

      // Membership is conferred by the lake's `datalake:*` meta-tag, so a body that OMITS one
      // evicts the file from that lake - gate the removals as well as the additions. `tags`
      // present at all is a wholesale replace (mongoose drops undefined from $set but writes an
      // empty array); anything unreadable as an array counts as the empty next set, so a
      // malformed payload demands manage rights instead of slipping past the check.
      const submittedTags: unknown = req.body.tags;
      const nextTagNames =
        submittedTags === undefined
          ? storedTagNames
          : (Array.isArray(submittedTags) ? submittedTags : []).map(tag => (tag as { name?: unknown } | null)?.name);

      const { affectedLakes: changedLakes, clearPrimaryTag } = await dataLakeService.assertCanReplaceDataLakeTags(
        { userId, isAdmin: !!req.user.isAdmin },
        {
          stored: storedTagNames,
          next: nextTagNames,
          primaryTag: req.body.primaryTag,
          storedPrimaryTag: storedFile?.primaryTag,
        },
        { db: { dataLakes: dataLakeRepository } }
      );

      try {
        const updated = await fabFilesService.updateFabFile(
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
            // would coalesce null to undefined and get dropped from the $set. Forced to null when
            // this write drops the tag it names, so the file is not left labelled with a tag it
            // no longer carries.
            primaryTag: clearPrimaryTag ? null : req.body.primaryTag,
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
        return { updatedFabFile: updated, affectedLakes: changedLakes };
      } catch (error) {
        req.logger.error('Error updating fab file:', { error, fileId: fabFileId });
        throw error;
      }
    });

    // After the commit, because the callback is retried on transient errors and a stats hiccup
    // must not roll back a good write; before logEvent, which is awaited unguarded. Stats are a
    // cache the batch finalizer and the read-time reconciler also rebuild, so one failing lake
    // must neither 500 a committed write nor skip the others.
    for (const lake of affectedLakes) {
      try {
        await dataLakeService.recomputeLakeStats(lake.id, lake.datalakeTag, {
          db: { dataLakes: dataLakeRepository, fabFiles: fabFileRepository },
        });
      } catch (error) {
        req.logger.error('Error recomputing data lake stats after a file tag change:', {
          error,
          fileId: fabFileId,
          lakeId: lake.id,
        });
      }
    }

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

    // A delete is a membership change too: deleteFabFile soft-deletes via `deletedAt`, and
    // computeDataLakeStats matches `deletedAt: null`, so every lake this file belonged to now
    // reports a stale count. Uses the tags read above, since the document is gone by now.
    // Best-effort per lake for the same reasons as the PUT branch: the write already succeeded.
    if (deleteAction === 'deleted') {
      const metaTags = new Set(
        (fabFile?.tags ?? [])
          .map(tag => tag?.name)
          .filter(isDatalakeMetaTag)
          .map(name => name.toLowerCase())
      );
      for (const tag of metaTags) {
        try {
          const lake = await dataLakeRepository.findByDatalakeTag(tag);
          if (lake) {
            await dataLakeService.recomputeLakeStats(lake.id, lake.datalakeTag, {
              db: { dataLakes: dataLakeRepository, fabFiles: fabFileRepository },
            });
          }
        } catch (error) {
          req.logger.error('Error recomputing data lake stats after a file delete:', {
            error,
            fileId: fabFileId,
            datalakeTag: tag,
          });
        }
      }
    }

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
