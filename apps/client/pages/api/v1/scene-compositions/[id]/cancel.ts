/** POST /api/v1/scene-compositions/{id}/cancel - request cancellation and return the job. */
import { cancelSceneCompositionContract, NotFoundError } from '@bike4mind/common';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { cancelOwnGenerationJob } from '@server/generations/cancelOwnGenerationJob';
import { findOwnGenerationJob } from '@bike4mind/server-utils/generations/findOwnGenerationJob';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';
import { mapperDeps } from '@server/generations/routeDeps';
import { SCENE_COMPOSITION_PROJECTION, toPublicGenerationJob } from '@server/generations/toPublicGenerationJob';

const handler = nextRouteForContract(cancelSceneCompositionContract, {
  rateLimit: perUserRateLimit('POST /api/v1/scene-compositions/[id]/cancel'),
}).post(async (req, res) => {
  const job = await findOwnGenerationJob(req.validatedParams.id, req.user.id, 'compose');
  if (!job) throw new NotFoundError('Scene composition not found');
  return res.json(
    await toPublicGenerationJob(await cancelOwnGenerationJob(job), mapperDeps, SCENE_COMPOSITION_PROJECTION)
  );
});

export const config = {
  api: { externalResolver: true },
};

export default handler;
