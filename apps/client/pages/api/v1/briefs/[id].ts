/**
 * GET /api/v1/briefs/{id} - read one brief. JWT only; another user's brief is `404`, like a missing one.
 */
import { NotFoundError, getBriefContract } from '@bike4mind/common';
import { assistantBriefRepository } from '@bike4mind/database';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';
import { serializeBrief } from '@server/briefs/serializeBrief';

const route = nextRouteForContract(getBriefContract, {
  rateLimit: perUserRateLimit('GET /api/v1/briefs/[id]'),
  recordsActivity: false,
}).get(async (req, res) => {
  const brief = await assistantBriefRepository.findByIdForUser(req.validatedParams.id, req.user.id);
  if (!brief) throw new NotFoundError('Brief not found');
  return res.json(await serializeBrief(brief));
});

export const config = {
  api: { externalResolver: true },
};

export default route;
