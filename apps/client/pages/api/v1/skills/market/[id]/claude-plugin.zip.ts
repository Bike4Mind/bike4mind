/**
 * GET /api/v1/skills/market/{id}/claude-plugin.zip - one Organization listing's approved version
 * as a Claude Code plugin archive. The feed (claude-marketplace.json.ts) pins these bytes by sha256.
 */
import { getClaudePluginZipContract } from '@bike4mind/common';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { NotFoundError } from '@server/utils/errors';
import { canSeeListing, findListing, memberOrgIdsFor } from '@bike4mind/server-utils/skillMarket/market';
import { pluginZipFor } from '@server/skillMarket/claudeMarketplace';

const handler = nextRouteForContract(getClaudePluginZipContract).get(async (req, res) => {
  const listing = await findListing(req.validatedParams.id);
  // Organization listings only, matching the feed; 404 either way so a listing's existence isn't confirmed.
  const visible = listing?.visibility === 'organization' && canSeeListing(listing, await memberOrgIdsFor(req.user.id));
  const zip = visible ? await pluginZipFor(listing, req.validatedQuery.version) : null;
  if (!zip) throw new NotFoundError('Listing not found');

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Cache-Control', 'private, no-store');
  return res.status(200).send(zip);
});

export default handler;

export const config = {
  api: {
    externalResolver: true,
  },
};
