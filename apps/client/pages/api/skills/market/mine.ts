// apps/client/pages/api/skills/market/mine.ts
import { baseApi } from '@client/server/middlewares/baseApi';
import { SkillListing, SkillListingVersion } from '@bike4mind/database';
import { serializeListing } from '@server/skillMarket/market';

/** GET /api/skills/market/mine - the caller's listings with their recent versions, findings and review notes. */
const handler = baseApi({ auth: 'jwtOnly' }).get(async (req, res) => {
  const listings = await SkillListing.find({ authorUserId: req.user!.id, deletedAt: null })
    .sort({ createdAt: -1 })
    .limit(100);
  const versions = await SkillListingVersion.find({ listingId: { $in: listings.map(l => String(l._id)) } })
    .sort({ version: -1 })
    .select('-snapshot.body')
    .limit(500);

  const byListing = new Map<string, unknown[]>();
  for (const v of versions) {
    const list = byListing.get(v.listingId) ?? [];
    if (list.length < 5) list.push(v.toJSON());
    byListing.set(v.listingId, list);
  }

  res.json({
    data: listings.map(l => ({
      ...serializeListing(l, { privileged: true }),
      versions: byListing.get(String(l._id)) ?? [],
    })),
  });
});

export default handler;
