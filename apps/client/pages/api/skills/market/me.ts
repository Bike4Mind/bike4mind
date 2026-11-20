// apps/client/pages/api/skills/market/me.ts
import { baseApi } from '@client/server/middlewares/baseApi';
import { spaceRepository } from '@bike4mind/database';
import { organizationRepository } from '@bike4mind/database/infra';
import { adminAudienceIdsFor, audienceIdsFor } from '@bike4mind/server-utils/skillMarket/market';

/**
 * GET /api/skills/market/me - what the market UI needs about the caller: the organizations they
 * and Spaces they can publish to and browse, and whether they review anything (shows the Review
 * queue entry). `spaces` is empty while `EnableSpaces` is off.
 */
const handler = baseApi({ auth: 'jwtOnly' }).get(async (req, res) => {
  const userId = req.user!.id;
  const [{ orgIds, spaceIds }, admin] = await Promise.all([audienceIdsFor(userId), adminAudienceIdsFor(userId)]);
  const [orgs, spaces] = await Promise.all([
    Promise.all(orgIds.slice(0, 50).map(id => organizationRepository.findById(id))),
    Promise.all(spaceIds.slice(0, 50).map(id => spaceRepository.findLiveById(id))),
  ]);
  res.json({
    organizations: orgs.flatMap(o => (o ? [{ id: String(o.id), name: o.name }] : [])),
    spaces: spaces.flatMap(s => (s ? [{ id: String(s.id), name: s.name }] : [])),
    isReviewer: Boolean(req.user!.isAdmin) || admin.orgIds.length > 0 || admin.spaceIds.length > 0,
    isAdmin: Boolean(req.user!.isAdmin),
  });
});

export default handler;
