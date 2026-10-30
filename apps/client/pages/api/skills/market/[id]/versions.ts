// apps/client/pages/api/skills/market/[id]/versions.ts
import { z } from 'zod';
import { baseApi } from '@client/server/middlewares/baseApi';
import { serializeListing, submitRateLimits } from '@server/skillMarket/market';
import { submitNewVersion } from '@server/skillMarket/author';

const bodySchema = z.object({ tags: z.array(z.string()).optional() });

/**
 * POST /api/skills/market/[id]/versions - submit the source skill's current content as a new
 * version (see `submitNewVersion`). v1 twin: pages/api/v1/skills/market/listings/[id]/versions.ts.
 */
const handler = baseApi({ auth: 'jwtOnly' })
  .use(...submitRateLimits())
  .post(async (req, res) => {
    const { tags } = bodySchema.parse(req.body ?? {});
    const { listing, version } = await submitNewVersion(req.user!, String(req.query.id), tags, req.logger);
    res.status(201).json({ listing: serializeListing(listing, { privileged: true }), version });
  });

export default handler;
