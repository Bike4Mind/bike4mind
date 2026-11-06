/**
 * GET /api/v1/skills/market/claude-marketplace.json?orgId= - the org's approved Organization
 * listings as a Claude Code plugin marketplace. A subset of what the caller can already browse
 * (marketVisibilityFilter), so it widens no access. Builder: server/skillMarket/claudeMarketplace.ts.
 */
import { getClaudeMarketplaceContract } from '@bike4mind/common';
import { organizationRepository } from '@bike4mind/database/infra';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { ForbiddenError } from '@server/utils/errors';
import { publicAppUrl } from '@server/utils/validators';
import { memberOrgIdsFor } from '@bike4mind/server-utils/skillMarket/market';
import { buildClaudeMarketplace } from '@server/skillMarket/claudeMarketplace';

const handler = nextRouteForContract(getClaudeMarketplaceContract).get(async (req, res) => {
  const { orgId } = req.validatedQuery;
  const memberOrgIds = await memberOrgIdsFor(req.user.id);
  const org = memberOrgIds.includes(orgId) ? await organizationRepository.findById(orgId) : null;
  if (!org) throw new ForbiddenError('You are not a member of this organization');

  res.setHeader('Cache-Control', 'private, no-store');
  return res.json(await buildClaudeMarketplace({ id: orgId, name: org.name }, memberOrgIds, publicAppUrl(req)));
});

export default handler;

export const config = {
  api: {
    externalResolver: true,
  },
};
