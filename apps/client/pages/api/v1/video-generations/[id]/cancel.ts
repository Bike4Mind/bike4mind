/** POST /api/v1/video-generations/{id}/cancel - request cancellation and return the job. */
import { cancelVideoGenerationContract, NotFoundError } from '@bike4mind/common';
import { generationJobRepository } from '@bike4mind/database';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { getGenerationJobEngine } from '@server/generationJobs/wiring';
import { findOwnVideoJob } from '@server/videoGenerations/findOwnVideoJob';
import { mapperDeps, perUserRateLimit } from '@server/videoGenerations/routeDeps';
import { toPublicVideoGeneration } from '@server/videoGenerations/toPublicVideoGeneration';

const handler = nextRouteForContract(cancelVideoGenerationContract, {
  rateLimit: perUserRateLimit('POST /api/v1/video-generations/[id]/cancel'),
}).post(async (req, res) => {
  const job = await findOwnVideoJob(req.validatedParams.id, req.user.id);
  if (!job) throw new NotFoundError('Video generation not found');
  // null: already storing or terminal, so the provider has produced (and charged for) the video; report it as is.
  const requested = await getGenerationJobEngine().requestCancel(job.id);
  const current = requested ?? (await generationJobRepository.findById(job.id)) ?? job;
  return res.json(await toPublicVideoGeneration(current, mapperDeps));
});

export const config = {
  api: { externalResolver: true },
};

export default handler;
