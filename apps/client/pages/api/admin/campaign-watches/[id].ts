import { CampaignWatchChangeSchema, CampaignWatchIdSchema, ForbiddenError } from '@bike4mind/common';
import type { Request } from 'express';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { parseOrBadRequest } from '@bike4mind/server-utils/utils/errors';
import { adminApi } from '@server/middlewares/adminApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { campaignWatchDetail, changeCampaignWatch } from '@server/admin/campaignWatches';

const handler = adminApi({ auth: 'jwtOnly', adminPermissions: { GET: 'support:read', PATCH: 'users:moderate' } })
  .use(rateLimit({ limit: 60, windowMs: 60_000, bucket: 'admin-campaign-watches' }))
  .get(
    asyncHandler<Request['params'], unknown, unknown, Request['query']>(async (req, res) => {
      if (!req.user?.isAdmin) throw new ForbiddenError('Admin access required');
      res.setHeader('Cache-Control', 'private, no-store');
      return res.json(await campaignWatchDetail(parseOrBadRequest(CampaignWatchIdSchema, req.query.id)));
    })
  )
  .patch(
    asyncHandler<Request['params'], unknown, unknown, Request['query']>(async (req, res) => {
      if (!req.user?.isAdmin) throw new ForbiddenError('Admin access required');
      return res.json(
        await changeCampaignWatch(
          req,
          parseOrBadRequest(CampaignWatchIdSchema, req.query.id),
          parseOrBadRequest(CampaignWatchChangeSchema, req.body)
        )
      );
    })
  );
export const config = { api: { externalResolver: true, bodyParser: { sizeLimit: '8kb' } } };
export default handler;
