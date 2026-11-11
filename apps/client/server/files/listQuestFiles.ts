import {
  adminSettingsRepository,
  fabFileRepository,
  questRepository,
  sessionRepository,
  userRepository,
} from '@bike4mind/database';
import { fabFilesService } from '@bike4mind/services';
import { getFilesStorage } from '@bike4mind/server-utils/utils/storage/index';
import { fileContentUrl } from '@server/files/browserFileSigner';

/**
 * The files attached to one quest, with a fresh signed `fileUrl` on each serveable file. Shared by
 * the SPA-internal `GET /api/quests/[id]/files` and the public `GET /api/v1/quests/[id]/files`, so
 * the DB and storage wiring cannot drift; the public route projects the result through toPublicFile.
 *
 * Throws NotFoundError for a quest that does not exist, or whose session the caller cannot see.
 * `browser` hands out the stable app URL (browserFileSigner.ts) instead of a raw S3 link.
 */
export async function listQuestFiles(userId: string, questId: string, { browser = false }: { browser?: boolean } = {}) {
  return fabFilesService.listFabFilesByQuest(
    userId,
    { questId },
    {
      db: {
        chatHistories: questRepository,
        fabFiles: fabFileRepository,
        sessions: sessionRepository,
        users: userRepository,
        adminSettings: adminSettingsRepository,
      },
      storage: {
        generateSignedUrl: async (path: string, expireInSeconds: number, options?: { signingDate?: Date }) =>
          getFilesStorage().getSignedUrl(path, 'get', {
            expiresIn: expireInSeconds,
            audience: 'browser',
            signingDate: options?.signingDate,
          }),
        ...(browser && { contentUrl: fileContentUrl }),
      },
    }
  );
}
