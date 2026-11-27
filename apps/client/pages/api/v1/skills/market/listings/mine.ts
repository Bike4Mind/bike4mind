/**
 * GET /api/v1/skills/market/listings/mine - the public, cursor-paginated twin of
 * GET /api/skills/market/mine, with a `source_skill_id` filter so a client can find the listing it
 * published from a skill in one call.
 */
import { listMySkillMarketListingsContract } from '@bike4mind/common';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { decodeTimeIdCursor, encodeTimeIdCursor } from '@server/utils/cursorPagination';
import { listMyListings } from '@server/skillMarket/author';
import { toPublicListing, toPublicVersion } from '@server/skillMarket/publicView';

const CURSOR_SCOPE = 'v1.skills.market.listings.mine';

const handler = nextRouteForContract(listMySkillMarketListingsContract).get(async (req, res) => {
  const { limit, cursor, source_skill_id } = req.validatedQuery;
  const { listings, next } = await listMyListings(req.user.id, {
    limit,
    after: cursor === undefined ? undefined : decodeTimeIdCursor(cursor, CURSOR_SCOPE),
    sourceSkillId: source_skill_id,
  });

  return res.json({
    data: listings.map(({ listing, versions }) => ({
      ...toPublicListing(listing, { privileged: true }),
      versions: versions.map(v => toPublicVersion(v, { privileged: true })),
    })),
    next_cursor: next ? encodeTimeIdCursor(CURSOR_SCOPE, next) : null,
  });
});

export default handler;

export const config = {
  api: { externalResolver: true },
};
