import { CampaignWatchCreateSchema, CampaignWatchListQuerySchema, ForbiddenError } from '@bike4mind/common';
import type { Request } from 'express';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { parseOrBadRequest } from '@bike4mind/server-utils/utils/errors';
import { adminApi } from '@server/middlewares/adminApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { createCampaignWatch, listCampaignWatches } from '@server/admin/campaignWatches';

const handler = adminApi({ auth: 'jwtOnly', adminPermissions: { GET: 'support:read', POST: 'users:moderate' } })
  .use(rateLimit({ limit: 60, windowMs: 60_000, bucket: 'admin-campaign-watches' }))
  .get(
    asyncHandler<Request['params'], unknown, unknown, Request['query']>(async (req, res) => {
      if (!req.user?.isAdmin) throw new ForbiddenError('Admin access required');
      res.setHeader('Cache-Control', 'private, no-store');
      const query = parseOrBadRequest(CampaignWatchListQuerySchema, req.query);
      return res.json(await listCampaignWatches(query.status, query.cursor));
    })
  )
  .post(
    asyncHandler<Request['params'], unknown, unknown, Request['query']>(async (req, res) => {
      if (!req.user?.isAdmin) throw new ForbiddenError('Admin access required');
      const result = await createCampaignWatch(req, parseOrBadRequest(CampaignWatchCreateSchema, req.body));
      return res.status(result.created ? 201 : 200).json(result);
    })
  );
export const config = { api: { externalResolver: true, bodyParser: { sizeLimit: '32kb' } } };
export default handler;
