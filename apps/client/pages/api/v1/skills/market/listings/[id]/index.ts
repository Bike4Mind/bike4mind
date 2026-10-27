/**
 * GET    /api/v1/skills/market/listings/{id} - the public twin of GET /api/skills/market/[id].
 * DELETE /api/v1/skills/market/listings/{id} - the public twin of DELETE /api/skills/market/[id].
 */
import {
  ApiKeyScope,
  NotFoundError,
  getSkillMarketListingContract,
  withdrawSkillMarketListingContract,
} from '@bike4mind/common';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { dispatchByMethod } from '@server/middlewares/dispatchByMethod';
import { holdsApiKeyScope } from '@server/middlewares/apiKeyScopeGate';
import { findListing } from '@bike4mind/server-utils/skillMarket/market';
import { buildListingDetail } from '@server/skillMarket/detail';
import { withdrawOwnListing } from '@server/skillMarket/author';
import { toPublicDetail } from '@server/skillMarket/publicView';

const getRoute = nextRouteForContract(getSkillMarketListingContract).get(async (req, res) => {
  const listing = await findListing(req.validatedParams.id);
  if (!listing) throw new NotFoundError('Listing not found');
  // isAdmin is withheld under an API key without admin:* (apiKeyAdminScope.ts), so a key never
  // reaches a listing through super-admin moderation rights.
  const detail = await buildListingDetail(
    listing,
    { id: req.user.id, isAdmin: req.user.isAdmin },
    req.validatedQuery.token
  );
  // A skills:read key is a plaintext Claude Code marketplace key: never hand it the share token.
  return res.json(toPublicDetail(detail, { allowPrivileged: holdsApiKeyScope(req, [ApiKeyScope.SKILLS_WRITE]) }));
});

const withdrawRoute = nextRouteForContract(withdrawSkillMarketListingContract).delete(async (req, res) => {
  await withdrawOwnListing(req.user.id, req.validatedParams.id);
  return res.status(204).end();
});

export const config = {
  api: { externalResolver: true },
};

export default dispatchByMethod({ GET: getRoute, DELETE: withdrawRoute });
