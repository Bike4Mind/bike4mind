// apps/client/pages/api/skills/market/mine.ts
import { baseApi } from '@client/server/middlewares/baseApi';
import { serializeListing } from '@bike4mind/server-utils/skillMarket/market';
import { listMyListings } from '@server/skillMarket/author';
import { templateSummariesByListing } from '@server/skillMarket/template';

/**
 * GET /api/skills/market/mine - the caller's listings with their recent versions, findings and review
 * notes, and each listing's template slug and status (`template: null` when it has none).
 */
const handler = baseApi({ auth: 'jwtOnly' }).get(async (req, res) => {
  const { listings } = await listMyListings(req.user!.id, { limit: 100 });
  const templates = await templateSummariesByListing(listings.map(({ listing }) => String(listing.id)));
  res.json({
    data: listings.map(({ listing, versions }) => ({
      ...serializeListing(listing, { privileged: true }),
      versions,
      template: templates.get(String(listing.id)) ?? null,
    })),
  });
});

export default handler;
