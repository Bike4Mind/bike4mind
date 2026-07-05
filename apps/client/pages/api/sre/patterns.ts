/**
 * SRE Patterns API - Returns error pattern library entries for the admin UI.
 */

import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { ForbiddenError } from '@server/utils/errors';
import { sreErrorPatternRepository } from '@bike4mind/database';

const handler = baseApi().get(
  asyncHandler(async (req, res) => {
    if (!req.user.isAdmin) throw new ForbiddenError('Permission denied');

    const query = req.query as Record<string, string | string[] | undefined>;
    const repoSlug = typeof query.repoSlug === 'string' ? query.repoSlug : undefined;
    const patterns = await sreErrorPatternRepository.findRecent(100, repoSlug);
    res.status(200).json(patterns);
  })
);

export default handler;
