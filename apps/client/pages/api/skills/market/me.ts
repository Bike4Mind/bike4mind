// apps/client/pages/api/skills/market/me.ts
import { baseApi } from '@client/server/middlewares/baseApi';
import { organizationRepository } from '@bike4mind/database/infra';
import { memberOrgIdsFor } from '@bike4mind/server-utils/skillMarket/market';

/**
 * GET /api/skills/market/me - what the market UI needs about the caller: the organizations they
 * can publish to and browse, and whether they review anything (shows the Review queue entry).
 */
const handler = baseApi({ auth: 'jwtOnly' }).get(async (req, res) => {
  const userId = req.user!.id;
  const [orgIds, adminOrgIds] = await Promise.all([
    memberOrgIdsFor(userId),
    organizationRepository.findIdsAdministeredBy(userId),
  ]);
  const orgs = await Promise.all(orgIds.slice(0, 50).map(id => organizationRepository.findById(id)));
  res.json({
    organizations: orgs.flatMap(o => (o ? [{ id: String(o.id), name: o.name }] : [])),
    isReviewer: Boolean(req.user!.isAdmin) || adminOrgIds.length > 0,
    isAdmin: Boolean(req.user!.isAdmin),
  });
});

export default handler;
