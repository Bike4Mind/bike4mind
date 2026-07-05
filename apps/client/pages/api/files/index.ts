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
import qs from 'qs';

const handler = baseApi()
  // GET /api/files
  .get(async (req, res) => {
    const userId = req.user.id;

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
    try {
      if (!req.ability) {
        return res.status(403).json({ error: 'Unauthorized' });
      }

      const userId = req.user.id;
      if (!userId) {
        return res.status(401).json({ error: 'User not authenticated' });
      }

      const accessible = accessibleBy(req.ability, Permission.delete).ofType(FabFile);

      await withTransaction(async session => {
        try {
          const files = await FabFile.find(accessible).select('filePath').session(session);
          const user = await User.findById(userId).session(session);

          if (!user) {
            throw new Error(`User not found: ${userId}`);
          }

          const filePaths = files.map(file => file.filePath).filter((filePath): filePath is string => !!filePath);

          user.currentStorageSize = 0;

          await Promise.all([user.save({ session }), FabFile.deleteMany(accessible).session(session)]);

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
