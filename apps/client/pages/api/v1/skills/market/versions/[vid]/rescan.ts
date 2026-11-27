/** POST /api/v1/skills/market/versions/{vid}/rescan - the public twin of POST /api/skills/market/versions/[vid]/rescan. */
import { rescanSkillMarketVersionContract } from '@bike4mind/common';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { enforceSubmitRateLimits } from '@bike4mind/server-utils/skillMarket/market';
import { rescanOwnVersion } from '@server/skillMarket/author';
import { toPublicVersion } from '@server/skillMarket/publicView';

const handler = nextRouteForContract(rescanSkillMarketVersionContract, {
  // Same buckets as the SPA route, so mixing the two cannot double the allowance.
  rateLimit: (req, res, next) => enforceSubmitRateLimits(req, res).then(() => next(), next),
}).post(async (req, res) => {
  const version = await rescanOwnVersion(req.user, req.validatedParams.vid, req.logger);
  return res.json({ version: toPublicVersion(version, { privileged: true }) });
});

export default handler;

export const config = {
  api: { externalResolver: true },
};
