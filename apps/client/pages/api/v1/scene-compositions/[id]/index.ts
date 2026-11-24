/** GET /api/v1/scene-compositions/{id} - one job the caller requested; anything else is a 404. */
import { getSceneCompositionContract, NotFoundError } from '@bike4mind/common';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { findOwnGenerationJob } from '@bike4mind/server-utils/generations/findOwnGenerationJob';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';
import { mapperDeps } from '@server/generations/routeDeps';
import { SCENE_COMPOSITION_PROJECTION, toPublicGenerationJob } from '@server/generations/toPublicGenerationJob';

const handler = nextRouteForContract(getSceneCompositionContract, {
  // Clients poll this until the job is terminal; polling must not drain the daily request budget.
  exemptReadsFromDailyRateLimit: true,
  rateLimit: perUserRateLimit('GET /api/v1/scene-compositions/[id]'),
}).get(async (req, res) => {
  const job = await findOwnGenerationJob(req.validatedParams.id, req.user.id, 'compose');
  if (!job) throw new NotFoundError('Scene composition not found');
  return res.json(await toPublicGenerationJob(job, mapperDeps, SCENE_COMPOSITION_PROJECTION));
});

export const config = {
  api: { externalResolver: true },
};

export default handler;
