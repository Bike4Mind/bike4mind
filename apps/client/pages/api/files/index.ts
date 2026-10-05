import { FileEvents, Permission } from '@bike4mind/common';
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
import { baseApi } from '@server/middlewares/baseApi';
import { getFilesStorage } from '@server/utils/storage';
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
        generateSignedUrl: async (path: string, expireInSeconds: number) => {
          try {
            return await getFilesStorage().getSignedUrl(path, 'get', { expiresIn: expireInSeconds });
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

      await withTransaction(async session => {
        try {
          const files = await FabFile.find(ownedFilter).select('filePath').session(session);
          const user = await User.findById(userId).session(session);

          if (!user) {
            throw new Error(`User not found: ${userId}`);
          }

          const filePaths = files.map(file => file.filePath).filter((filePath): filePath is string => !!filePath);

          // Every owned file is going, and storage only ever counted the caller's own files.
          user.currentStorageSize = 0;

          await Promise.all([
            user.save({ session }),
            FabFile.deleteMany(ownedFilter, { session }),
            // includeDeleted: the grant must also leave soft-deleted shares, or restoring one
            // (e.g. a data-lake undelete) would hand the caller's access back.
            FabFile.updateMany(sharedInFilter, { $pull: { users: { userId } } }, { session }).setOptions({
              includeDeleted: true,
            }),
          ]);

          await Promise.all(
            filePaths.map(async filePath => {
              try {
                await getFilesStorage().delete(filePath);
              } catch (error) {
                req.logger.error('Error deleting file from storage:', {
                  error,
                  filePath,
                  userId,
                });
                throw error;
              }
            })
          );

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
