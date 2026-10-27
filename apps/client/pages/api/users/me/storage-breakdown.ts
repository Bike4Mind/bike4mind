import { dataLakeRepository, fabFileRepository, userRepository } from '@bike4mind/database';
import { userService } from '@bike4mind/services';
import { toAccessContext } from '@server/dataLakes/toAccessContext';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';

// One `$group` over the caller's own rows; the cap only matters for an account with a very large
// file count, where a slow answer is worse than a failed one the UI can retry.
export const STORAGE_BREAKDOWN_MAX_TIME_MS = 10000;
export const STORAGE_BREAKDOWN_RATE_LIMIT = 30;
const ONE_MINUTE_MS = 60 * 1000;

/**
 * GET /api/users/me/storage-breakdown - what uses the caller's storage, by source and per lake
 * (StorageBreakdownResponse). First-party only (`jwtOnly`): it is a profile surface, not an API-key
 * capability. The principal is always `req.user`; no query parameter selects the user.
 */
const handler = baseApi({ auth: 'jwtOnly' })
  .use(rateLimit({ limit: STORAGE_BREAKDOWN_RATE_LIMIT, windowMs: ONE_MINUTE_MS, bucket: 'storage-breakdown' }))
  .get(async (req, res) => {
    const breakdown = await userService.getUserStorageBreakdown(
      await toAccessContext(req),
      { db: { users: userRepository, fabFiles: fabFileRepository, dataLakes: dataLakeRepository } },
      { maxTimeMS: STORAGE_BREAKDOWN_MAX_TIME_MS }
    );
    res.setHeader('Cache-Control', 'private, no-store');
    return res.status(200).json(breakdown);
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
