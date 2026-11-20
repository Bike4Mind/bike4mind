/**
 * SRE Tracking API - Returns recent error tracking documents for the admin UI.
 */

import { asyncHandler } from '@server/middlewares/asyncHandler';
import { adminApi } from '@server/middlewares/adminApi';
import { sreErrorTrackingRepository } from '@bike4mind/database';

const handler = adminApi({ adminPermissions: { GET: 'support:read' } }).get(
  asyncHandler(async (req, res) => {
    const query = req.query as Record<string, string | string[] | undefined>;
    const repoSlug = typeof query.repoSlug === 'string' ? query.repoSlug : undefined;
    const docs = await sreErrorTrackingRepository.findRecent(50, repoSlug);
    res.status(200).json(docs);
  })
);

export default handler;
