/**
 * SRE Tracking API - Returns recent error tracking documents for the admin UI.
 */

import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { ForbiddenError } from '@server/utils/errors';
import { sreErrorTrackingRepository } from '@bike4mind/database';

const handler = baseApi().get(
  asyncHandler(async (req, res) => {
    if (!req.user.isAdmin) throw new ForbiddenError('Permission denied');

    const query = req.query as Record<string, string | string[] | undefined>;
    const repoSlug = typeof query.repoSlug === 'string' ? query.repoSlug : undefined;
    const docs = await sreErrorTrackingRepository.findRecent(50, repoSlug);
    res.status(200).json(docs);
  })
);

export default handler;
