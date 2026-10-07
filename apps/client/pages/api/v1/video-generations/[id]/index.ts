/** GET /api/v1/video-generations/{id} - one job the caller requested; anything else is a 404. */
import { getVideoGenerationContract, NotFoundError } from '@bike4mind/common';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { findOwnVideoJob } from '@server/videoGenerations/findOwnVideoJob';
import { mapperDeps, perUserRateLimit } from '@server/videoGenerations/routeDeps';
import { toPublicVideoGeneration } from '@server/videoGenerations/toPublicVideoGeneration';

const handler = nextRouteForContract(getVideoGenerationContract, {
  // Clients poll this until the job is terminal; polling must not drain the daily request budget.
  exemptReadsFromDailyRateLimit: true,
  rateLimit: perUserRateLimit('GET /api/v1/video-generations/[id]'),
}).get(async (req, res) => {
  const job = await findOwnVideoJob(req.validatedParams.id, req.user.id);
  if (!job) throw new NotFoundError('Video generation not found');
  return res.json(await toPublicVideoGeneration(job, mapperDeps));
});

export const config = {
  api: { externalResolver: true },
};

export default handler;
