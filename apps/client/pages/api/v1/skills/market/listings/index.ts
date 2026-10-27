/**
 * GET  /api/v1/skills/market/listings - the public, cursor-paginated twin of GET /api/skills/market.
 * POST /api/v1/skills/market/listings - the public twin of POST /api/skills/market/publish.
 *
 * Auth mode, scopes and validation come from the contracts; the SPA routes are unchanged. Every
 * listing renders through toPublicListing.
 */
import { listSkillMarketListingsContract, publishSkillMarketListingContract } from '@bike4mind/common';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { dispatchByMethod } from '@server/middlewares/dispatchByMethod';
import { UnprocessableEntityError } from '@bike4mind/server-utils/utils/errors';
import { decodeCursor, encodeCursor } from '@server/utils/cursorPagination';
import { enforceSubmitRateLimits, memberOrgIdsFor } from '@server/skillMarket/market';
import { searchListings } from '@server/skillMarket/search';
import { publishListing } from '@server/skillMarket/author';
import { toPublicListing, toPublicVersion } from '@server/skillMarket/publicView';

const CURSOR_SCOPE = 'v1.skills.market.listings';

// ponytail: the cursor wraps a page number, because the ranked sorts (relevance, top) have no stable
// keyset; rows can skip or repeat if rankings shift mid-iteration. Keyset per sort if that bites.
const browseRoute = nextRouteForContract(listSkillMarketListingsContract).get(async (req, res) => {
  const { limit, cursor, q, scope, tags, tools, min_rating, sort } = req.validatedQuery;
  const page = cursor === undefined ? 1 : Number(decodeCursor(cursor, CURSOR_SCOPE));
  // A cursor is only ever minted for page 2 onwards.
  if (cursor !== undefined && !(Number.isInteger(page) && page >= 2)) {
    throw new UnprocessableEntityError('Invalid cursor');
  }

  const result = await searchListings(await memberOrgIdsFor(req.user.id), {
    q,
    scope,
    tags: tags
      ?.split(',')
      .map(t => t.trim().toLowerCase())
      .filter(Boolean)
      .slice(0, 5),
    tools,
    minRating: min_rating || undefined,
    sort: sort ?? (q ? 'relevance' : 'top'),
    page,
    limit,
  });

  return res.json({
    data: result.data.map(listing => toPublicListing(listing)),
    next_cursor: result.hasMore ? encodeCursor(CURSOR_SCOPE, String(page + 1)) : null,
  });
});

const publishRoute = nextRouteForContract(publishSkillMarketListingContract, {
  // Same buckets as the SPA publish route, so mixing the two cannot double the allowance.
  rateLimit: (req, res, next) => enforceSubmitRateLimits(req, res).then(() => next(), next),
}).post(async (req, res) => {
  const body = req.validated;
  let organizationId = body.organization_id;
  // v1 only: a caller in exactly one organization need not name it.
  if (body.visibility === 'organization' && !organizationId) {
    const orgIds = await memberOrgIdsFor(req.user.id);
    if (orgIds.length === 1) organizationId = orgIds[0];
  }

  const { listing, version } = await publishListing(
    req.user,
    { skillId: body.skill_id, visibility: body.visibility, organizationId, tags: body.tags },
    req.logger
  );
  return res.status(201).json({
    listing: toPublicListing(listing, { privileged: true }),
    version: toPublicVersion(version, { privileged: true }),
  });
});

export const config = {
  api: { externalResolver: true },
};

export default dispatchByMethod({ GET: browseRoute, POST: publishRoute });
