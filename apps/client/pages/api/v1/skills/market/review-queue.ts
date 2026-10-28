/**
 * GET /api/v1/skills/market/review-queue - the public, cursor-paginated twin of the `pending` filter
 * of GET /api/skills/market/review-queue.
 */
import { listSkillMarketReviewQueueContract, type ISkillListingVersion } from '@bike4mind/common';
import { organizationRepository } from '@bike4mind/database/infra';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { decodeTimeIdCursor, encodeTimeIdCursor } from '@server/utils/cursorPagination';
import { loadVersionQueue, requireReviewer } from '@server/skillMarket/reviewQueue';
import { toPublicListing, toPublicSnapshot, toPublicVersion } from '@server/skillMarket/publicView';

const CURSOR_SCOPE = 'v1.skills.market.review-queue';

const handler = nextRouteForContract(listSkillMarketReviewQueueContract).get(async (req, res) => {
  const { limit, cursor } = req.validatedQuery;
  const actor = { id: req.user.id, isAdmin: req.user.isAdmin };
  const adminOrgIds = await organizationRepository.findIdsAdministeredBy(actor.id);
  requireReviewer(actor, adminOrgIds);

  const { rows, next } = await loadVersionQueue(actor, adminOrgIds, {
    filter: 'pending',
    limit,
    after: cursor === undefined ? undefined : decodeTimeIdCursor(cursor, CURSOR_SCOPE),
  });

  return res.json({
    data: rows.map(({ version, listing, previous, canDecide }) => ({
      version: toPublicVersion(version.toJSON() as unknown as ISkillListingVersion, { privileged: true }),
      listing: toPublicListing(listing, { privileged: true }),
      previous: previous
        ? {
            id: String(previous.id),
            version: previous.version,
            snapshot: toPublicSnapshot(previous.snapshot, { withFiles: false }),
          }
        : null,
      can_decide: canDecide,
    })),
    next_cursor: next ? encodeTimeIdCursor(CURSOR_SCOPE, next) : null,
  });
});

export default handler;

export const config = {
  api: { externalResolver: true },
};
