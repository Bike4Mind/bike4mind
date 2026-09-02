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
import { toObjectIdString } from '@server/utils/objectId';

const handler = baseApi()
  /**
   * Get all files from a session
   */
  .get(
    asyncHandler<{}, unknown, unknown, { showFiles?: string; id?: string }>(async (req, res) => {
      const userId = req.user!.id;
      const { id } = req.query;

      // Canonicalized: the session lookup casts and so matches any casing, but the
      // chat-history query below hits `sessionId: { type: String }` (QuestModel), which
      // does byte equality - an uppercase id would drop every chat-attached file.
      const sessionId = id ? toObjectIdString(id) : undefined;
      if (!sessionId) {
        return res.status(400).json({ error: 'Invalid session ID format' });
      }

      const results = await fabFilesService.listFabFilesBySession(
        userId,
        { sessionId },
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
