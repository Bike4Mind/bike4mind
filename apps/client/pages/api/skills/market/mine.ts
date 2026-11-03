// apps/client/pages/api/skills/market/mine.ts
import { baseApi } from '@client/server/middlewares/baseApi';
import { serializeListing } from '@bike4mind/server-utils/skillMarket/market';
import { listMyListings } from '@server/skillMarket/author';

/** GET /api/skills/market/mine - the caller's listings with their recent versions, findings and review notes. */
const handler = baseApi({ auth: 'jwtOnly' }).get(async (req, res) => {
  const { listings } = await listMyListings(req.user!.id, { limit: 100 });
  res.json({
    data: listings.map(({ listing, versions }) => ({ ...serializeListing(listing, { privileged: true }), versions })),
  });
});

export default handler;
