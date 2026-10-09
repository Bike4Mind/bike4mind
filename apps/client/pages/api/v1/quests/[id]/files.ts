/**
 * GET /api/v1/quests/{id}/files - the files attached to one quest, with signed download URLs. The
 * public twin of GET /api/quests/[id]/files: same service call and scopes, published through the
 * shared toPublicFile projection. fabFilesService.listFabFilesByQuest answers NotFoundError for a
 * quest that does not exist or whose session the caller cannot see.
 */

import { listQuestFilesContract } from '@bike4mind/common';
import {
  adminSettingsRepository,
  fabFileRepository,
  questRepository,
  sessionRepository,
  userRepository,
} from '@bike4mind/database';
import { fabFilesService } from '@bike4mind/services';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { getFilesStorage } from '@server/utils/storage';
import { isValidObjectId } from '@server/utils/objectId';
import { NotFoundError } from '@server/utils/errors';
import { toPublicFile } from '@server/files/toPublicFile';

const handler = nextRouteForContract(listQuestFilesContract, {
  // Part of the chat-reply poll, like GET /api/v1/quests/{id}: don't let polling burn the daily quota.
  exemptReadsFromDailyRateLimit: true,
}).get(async (req, res) => {
  const { id } = req.validatedParams;
  // A malformed id is a 404, not a CastError from deep in the query (CONVENTIONS.md status table).
  if (!isValidObjectId(id)) throw new NotFoundError('Quest not found');

  const files = await fabFilesService.listFabFilesByQuest(
    req.user.id,
    { questId: id },
    {
      db: {
        chatHistories: questRepository,
        fabFiles: fabFileRepository,
        sessions: sessionRepository,
        users: userRepository,
        adminSettings: adminSettingsRepository,
      },
      storage: {
        generateSignedUrl: (path: string, expireInSeconds: number) =>
          getFilesStorage().getSignedUrl(path, undefined, { expiresIn: expireInSeconds }),
      },
    }
  );

  res.setHeader('Cache-Control', 'private, no-store');
  return res.json({ files: files.map(toPublicFile) });
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
