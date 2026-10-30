// apps/client/pages/api/skills/market/versions/[vid]/rescan.ts
import { baseApi } from '@client/server/middlewares/baseApi';
import { submitRateLimits } from '@server/skillMarket/market';
import { rescanOwnVersion } from '@server/skillMarket/author';

/** POST /api/skills/market/versions/[vid]/rescan - the author retries a scan that errored or stalled. */
const handler = baseApi({ auth: 'jwtOnly' })
  .use(...submitRateLimits())
  .post(async (req, res) => {
    res.json({ version: await rescanOwnVersion(req.user!, String(req.query.vid), req.logger) });
  });

export default handler;
