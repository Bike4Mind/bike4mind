import {
  adminSettingsRepository,
  fabFileRepository,
  questRepository,
  sessionRepository,
  userRepository,
} from '@bike4mind/database';
import { listSessionFilesContract } from '@bike4mind/common';
import { fabFilesService } from '@bike4mind/services';
import { NotFoundError } from '@bike4mind/server-utils/utils/errors';
import { getFilesStorage } from '@bike4mind/server-utils/utils/storage/index';
import { toObjectIdString } from '@bike4mind/server-utils/utils/objectId';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';

const handler = nextRouteForContract(listSessionFilesContract, {
  // Reading what a session holds is not a metered action; only the per-minute burst limit applies.
  exemptReadsFromDailyRateLimit: true,
}).get(async (req, res) => {
  // Canonicalized: the session lookup casts and so matches any casing, but the chat-history query
  // below hits `sessionId: { type: String }` (QuestModel), which does byte equality - an uppercase id
  // would drop every chat-attached file. A malformed id names a session that cannot exist: 404.
  const sessionId = toObjectIdString(req.validatedParams.id);
  if (!sessionId) throw new NotFoundError('Session not found');

  const results = await fabFilesService.listFabFilesBySession(
    req.user.id,
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
        ...(process.env.S3_PRESIGN_ENDPOINT?.trim() && { signedUrlCache: 'bypass' as const }),
        generateSignedUrl: async (path: string, expireInSeconds: number) => {
          return await getFilesStorage().getSignedUrl(path, 'get', {
            expiresIn: expireInSeconds,
            audience: 'browser',
          });
        },
      },
    }
  );

  return res.json(results);
});

export default handler;

export const config = {
  api: {
    externalResolver: true,
  },
};
