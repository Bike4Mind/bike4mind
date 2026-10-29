/**
 * SRE Patterns API - Returns error pattern library entries for the admin UI.
 */

import { asyncHandler } from '@server/middlewares/asyncHandler';
import { adminApi } from '@server/middlewares/adminApi';
import { sreErrorPatternRepository } from '@bike4mind/database';

const handler = adminApi({ adminPermissions: { GET: 'support:read' } }).get(
  asyncHandler(async (req, res) => {
    const query = req.query as Record<string, string | string[] | undefined>;
    const repoSlug = typeof query.repoSlug === 'string' ? query.repoSlug : undefined;
    const patterns = await sreErrorPatternRepository.findRecent(100, repoSlug);
    res.status(200).json(patterns);
  })
);

export default handler;
