import { ForbiddenError, isFullAdmin } from '@bike4mind/common';
import { adminMorningBriefRepository } from '@bike4mind/database';
import { Config } from '@bike4mind/server-utils/utils/config';
import { adminApi } from '@server/middlewares/adminApi';

export default adminApi({ auth: 'jwtOnly', adminPermissions: { GET: 'support:read' } }).get(async (req, res) => {
  if (!isFullAdmin(req.user)) throw new ForbiddenError('Full admin access is required');
  const brief = await adminMorningBriefRepository.findLatest(Config.STAGE);
  res.setHeader('Cache-Control', 'private, no-store');
  return res.json({
    brief: brief
      ? {
          environment: brief.environment,
          day: brief.day,
          generatedAt: brief.generatedAt.toISOString(),
          facts: brief.facts,
          summary: brief.summary,
          needsHuman: brief.needsHuman,
          delivery: brief.delivery,
        }
      : null,
  });
});
