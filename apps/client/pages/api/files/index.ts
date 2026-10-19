import { chargedBytes, FileEvents, Permission, storageOwnerOf, sumStorageDeltaByOwner } from '@bike4mind/common';
import {
  adminSettingsRepository,
  FabFile,
  fabFileRepository,
  projectRepository,
  User,
  userRepository,
  withTransaction,
} from '@bike4mind/database';
import { fabFilesService } from '@bike4mind/services';
import { accessibleBy } from '@casl/mongoose';
import { logEvent } from '@server/utils/analyticsLog';
import { unpublishUserArtifactsBySource } from '@server/services/publish/purgeUserPublishedArtifacts';
import { baseApi } from '@server/middlewares/baseApi';
import { adjustOwnerStorageInSession } from '@server/s3/storageCharge';
import { getFilesStorage } from '@server/utils/storage';
import { getGeneratedCopyStore } from '@server/files/generatedCopyStore';
import { assertFilesReadScope, assertFilesWriteScope, FILES_READ_OR_WRITE_SCOPES } from '@server/files/fileScopes';
import qs from 'qs';

// baseApi's scope gate is per route, so it admits either files scope and each method asserts its own.
const handler = baseApi({ requiredScopes: FILES_READ_OR_WRITE_SCOPES })
  // GET /api/files
  .get(async (req, res) => {
    assertFilesReadScope(req);
    const userId = req.user.id;

    // No server scope argument, so the default view lists only files this user owns. The query
    // string cannot widen that: every scope option now lives outside the parsed params (see
    // SearchFabFilesServerOptions). The shared and curated views still work - they come from
    // `filters`, not `options`, and each carries its own ownership predicate.
    const results = await fabFilesService.search(userId, qs.parse(req.query as Record<string, any>), {
      db: {
        fabFiles: fabFileRepository,
        users: userRepository,
        projects: projectRepository,
        adminSettings: adminSettingsRepository,
      },
      storage: {
        ...(process.env.S3_PRESIGN_ENDPOINT?.trim() && { signedUrlCache: 'bypass' as const }),
        generateSignedUrl: async (path: string, expireInSeconds: number) => {
          try {
            return await getFilesStorage().getSignedUrl(path, 'get', {
              expiresIn: expireInSeconds,
              audience: 'browser',
            });
          } catch (e) {
            req.logger.error('Error generating signed URL for file', {
              error: e,
              filePath: path,
              userId,
            });
            return null;
          }
        },
      },
    });

    return res.json(results);
  })
  // DELETE /api/files
  .delete(async (req, res) => {
    assertFilesWriteScope(req);
    try {
      if (!req.ability) {
        return res.status(403).json({ error: 'Unauthorized' });
      }

      const userId = req.user.id;
      if (!userId) {
        return res.status(401).json({ error: 'User not authenticated' });
      }

      // "Delete all my files" must only destroy the caller's OWN files. A delete grant on someone
      // else's shared file authorizes removing it from the caller's view, not destroying the
      // owner's document and its S3 bytes - so that half of the scope is unshared instead.
      // $and rather than a merged object literal: the CASL scope carries its own $or/userId arms
      // and a spread would silently drop one of them.
      const deletable = accessibleBy(req.ability, Permission.delete).ofType(FabFile);
      const ownedFilter = { $and: [deletable, { userId }] };
      const sharedInFilter = { $and: [deletable, { userId: { $ne: userId } }] };

      // Published files are snapshots that outlive the file, so take them down first: a retry after
      // a failed delete still finds the files and finishes the job.
      const fabFileIds = (await FabFile.find(ownedFilter).select('_id').lean()).map(f => String(f._id));
      await unpublishUserArtifactsBySource(userId, { kind: 'fabfile', fabFileIds }, { logger: req.logger });

      await withTransaction(async session => {
        try {
          // sessionId feeds deleteStoredObjects' fork guard: without it the file's own notebook reads as another's.
          const files = await FabFile.find(ownedFilter)
            .select(
              'filePath versions moderationStatus blockReason sourceMetadata.generatedCopyKey sourceMetadata.sessionId ' +
                'organizationId fileSize storageChargedAt status createdAt'
            )
            .session(session);
          const user = await User.findById(userId).session(session);

          if (!user) {
            throw new Error(`User not found: ${userId}`);
          }

          const filePaths = files.map(file => file.filePath).filter((filePath): filePath is string => !!filePath);

          // Every personal file the caller owns is going, so their counter empties; an org-stamped
          // file was billed to its org (storageOwnerOf), which gets its own refund instead.
          user.currentStorageSize = 0;
          const orgRefunds = sumStorageDeltaByOwner(
            files
              .filter(file => file.organizationId)
              .map(file => ({
                owner: storageOwnerOf({ userId, organizationId: file.organizationId }),
                bytes: -chargedBytes(file),
              }))
          );
          for (const { owner, bytes } of orgRefunds) {
            await adjustOwnerStorageInSession(owner, bytes, session);
          }

          await Promise.all([
            user.save({ session }),
            FabFile.deleteMany(ownedFilter, { session }),
            // includeDeleted: the grant must also leave soft-deleted shares, or restoring one
            // (e.g. a data-lake undelete) would hand the caller's access back.
            FabFile.updateMany(sharedInFilter, { $pull: { users: { userId } } }, { session }).setOptions({
              includeDeleted: true,
            }),
          ]);

          if (files.length > 0) {
            try {
              await fabFilesService.deleteStoredObjects(
                files,
                { files: getFilesStorage(), generated: getGeneratedCopyStore() },
                req.logger
              );
            } catch (error) {
              req.logger.error('Error deleting file from storage:', { error, userId });
              throw error;
            }
          }

          await logEvent(
            {
              userId,
              type: FileEvents.DELETE_ALL_FILES,
              metadata: { fileCount: filePaths.length },
            },
            { session, ability: req.ability }
          );
        } catch (error) {
          req.logger.error('Transaction error in DELETE /api/files:', {
            error,
            userId,
          });
          throw error;
        }
      });

      return res.status(204).send();
    } catch (error) {
      req.logger.error('Error in DELETE /api/files:', {
        error,
        userId: req.user?.id,
      });
      throw error;
    }
  });

export const config = {
  api: {
    externalResolver: true,
    bodyParser: {
      sizeLimit: '10mb',
    },
    responseLimit: false,
  },
};

export default handler;
