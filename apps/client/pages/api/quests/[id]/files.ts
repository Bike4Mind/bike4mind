import { baseApi } from '@server/middlewares/baseApi';
import {
  adminSettingsRepository,
  fabFileRepository,
  questRepository,
  sessionRepository,
  userRepository,
} from '@bike4mind/database';
import { fabFilesService } from '@bike4mind/services';
import { ApiKeyScope } from '@bike4mind/common';
import { getFilesStorage } from '@server/utils/storage';

// Quest files are part of the documented chat-reply poll, so an AI scope
// (ai:chat / ai:generate) grants read here as well as notebooks:read. OR
// / "any of" semantics - see quests/[id]/index.ts.
const handler = baseApi({
  requiredScopes: [ApiKeyScope.READ_NOTEBOOKS, ApiKeyScope.AI_CHAT, ApiKeyScope.AI_GENERATE],
})
  /**
   * Get all files from a quest (message-level files)
   */
  .get(async (req, res) => {
    const userId = req.user!.id;
    const { id } = req.query as { id?: string };

    const results = await fabFilesService.listFabFilesByQuest(
      userId,
      { questId: id! },
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
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
