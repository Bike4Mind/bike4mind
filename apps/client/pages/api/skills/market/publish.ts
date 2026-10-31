// apps/client/pages/api/skills/market/publish.ts
import { z } from 'zod';
import { baseApi } from '@client/server/middlewares/baseApi';
import { serializeListing, submitRateLimits } from '@bike4mind/server-utils/skillMarket/market';
import { publishListing } from '@server/skillMarket/author';

const bodySchema = z.object({
  skillId: z.string().min(1),
  visibility: z.enum(['public', 'organization', 'unlisted']),
  organizationId: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

/**
 * POST /api/skills/market/publish - create a listing from a skill the caller owns and submit its
 * first version for the safety scan. Responds with the listing and the scanned version, so the
 * dialog can show the verdict inline. v1 twin: pages/api/v1/skills/market/listings/index.ts.
 */
const handler = baseApi({ auth: 'jwtOnly' })
  .use(...submitRateLimits())
  .post(async (req, res) => {
    const body = bodySchema.parse(req.body);
    const { listing, version } = await publishListing(req.user!, body, req.logger);
    res.status(201).json({ listing: serializeListing(listing, { privileged: true }), version });
  });

export default handler;
