/** POST /api/v1/skills/market/listings/{id}/versions - the public twin of POST /api/skills/market/[id]/versions. */
import { submitSkillMarketListingVersionContract } from '@bike4mind/common';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { enforceSubmitRateLimits } from '@bike4mind/server-utils/skillMarket/market';
import { submitNewVersion } from '@server/skillMarket/author';
import { toPublicListing, toPublicVersion } from '@server/skillMarket/publicView';

const handler = nextRouteForContract(submitSkillMarketListingVersionContract, {
  // Same buckets as the SPA route, so mixing the two cannot double the allowance.
  rateLimit: (req, res, next) => enforceSubmitRateLimits(req, res).then(() => next(), next),
}).post(async (req, res) => {
  const { listing, version } = await submitNewVersion(req.user, req.validatedParams.id, req.validated.tags, req.logger);
  return res.status(201).json({
    listing: toPublicListing(listing, { privileged: true }),
    version: toPublicVersion(version, { privileged: true }),
  });
});

export default handler;

export const config = {
  api: { externalResolver: true },
};
