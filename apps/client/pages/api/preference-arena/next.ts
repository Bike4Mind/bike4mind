import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { getArenaService } from '@server/preferenceArena';

const MINUTE_MS = 60 * 1000;

/** GET /api/preference-arena/next - the caller's outstanding pair, or a fresh one (answers carry no model ids). */
const handler = baseApi({ auth: 'jwtOnly' })
  .use(rateLimit({ limit: 60, windowMs: MINUTE_MS, bucket: 'preference-arena-next' }))
  .get(async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    return res.status(200).json(await getArenaService(req.logger).serveNextPair(req.user.id));
  });

export default handler;

export const config = {
  api: {
    externalResolver: true,
  },
};
