import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import {
  adminSettingsRepository,
  fabFileRepository,
  questRepository,
  sessionRepository,
  userRepository,
} from '@bike4mind/database';
import { fabFilesService } from '@bike4mind/services';
import { getFilesStorage } from '@server/utils/storage';
import { Types } from 'mongoose';

const isValidObjectId = (id: string): boolean => {
  return Types.ObjectId.isValid(id) && new Types.ObjectId(id).toString() === id;
};

const handler = baseApi()
  /**
   * Get all files from a session
   */
  .get(
    asyncHandler<{}, unknown, unknown, { showFiles?: string; id?: string }>(async (req, res) => {
      const userId = req.user!.id;
      const { id } = req.query;

      if (!id || !isValidObjectId(id)) {
        return res.status(400).json({ error: 'Invalid session ID format' });
      }

      const results = await fabFilesService.listFabFilesBySession(
        userId,
        { sessionId: id! },
        {
          db: {
            chatHistories: questRepository,
            fabFiles: fabFileRepository,
            sessions: sessionRepository,
            users: userRepository,
            adminSettings: adminSettingsRepository,
          },
          storage: {
            generateSignedUrl: async (path: string, expireInSeconds: number) => {
              return await getFilesStorage().getSignedUrl(path, undefined, { expiresIn: expireInSeconds });
            },
          },
        }
      );

      return res.json(results);
    })
  );

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
