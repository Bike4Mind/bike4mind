/**
 * GET /api/v1/skills/market/claude-marketplace.json?orgId= or ?spaceId= - the org's approved
 * Organization listings, or the Space's listings, as a Claude Code plugin marketplace. A subset of what the caller can already browse
 * (marketVisibilityFilter), so it widens no access. Builder: server/skillMarket/claudeMarketplace.ts.
 */
import { getClaudeMarketplaceContract } from '@bike4mind/common';
import { spaceRepository } from '@bike4mind/database';
import { organizationRepository } from '@bike4mind/database/infra';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { ForbiddenError, UnprocessableEntityError } from '@bike4mind/server-utils/utils/errors';
import { publicAppUrl } from '@bike4mind/server-utils/utils/validators';
import { audienceIdsFor } from '@bike4mind/server-utils/skillMarket/market';
import { buildClaudeMarketplace, type MarketplaceOwner } from '@server/skillMarket/claudeMarketplace';

const handler = nextRouteForContract(getClaudeMarketplaceContract).get(async (req, res) => {
  const { orgId, spaceId } = req.validatedQuery;
  if (Boolean(orgId) === Boolean(spaceId)) throw new UnprocessableEntityError('Send exactly one of orgId or spaceId');
  const audience = await audienceIdsFor(req.user.id);

  let owner: MarketplaceOwner;
  if (spaceId) {
    // spaceIds is empty while EnableSpaces is off, so the flag answers 403 here.
    const space = audience.spaceIds.includes(spaceId) ? await spaceRepository.findLiveById(spaceId) : null;
    if (!space) throw new ForbiddenError('You are not a member of this space');
    owner = { spaceId, name: space.name };
  } else {
    const org = audience.orgIds.includes(orgId!) ? await organizationRepository.findById(orgId!) : null;
    if (!org) throw new ForbiddenError('You are not a member of this organization');
    owner = { orgId: orgId!, name: org.name };
  }

  res.setHeader('Cache-Control', 'private, no-store');
  return res.json(await buildClaudeMarketplace(owner, audience, publicAppUrl(req)));
});

export default handler;

export const config = {
  api: {
    externalResolver: true,
  },
};
