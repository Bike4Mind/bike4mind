/** POST /api/v1/video-generations/{id}/cancel - request cancellation and return the job. */
import { cancelVideoGenerationContract, NotFoundError } from '@bike4mind/common';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { cancelOwnGenerationJob } from '@server/generations/cancelOwnGenerationJob';
import { findOwnGenerationJob } from '@server/generations/findOwnGenerationJob';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';
import { mapperDeps } from '@server/generations/routeDeps';
import { toPublicVideoGeneration } from '@server/videoGenerations/toPublicVideoGeneration';

const handler = nextRouteForContract(cancelVideoGenerationContract, {
  rateLimit: perUserRateLimit('POST /api/v1/video-generations/[id]/cancel'),
}).post(async (req, res) => {
  const job = await findOwnGenerationJob(req.validatedParams.id, req.user.id, 'video');
  if (!job) throw new NotFoundError('Video generation not found');
  return res.json(await toPublicVideoGeneration(await cancelOwnGenerationJob(job), mapperDeps));
});

export const config = {
  api: { externalResolver: true },
};

export default handler;
