/** POST /api/v1/image-jobs/{id}/cancel - request cancellation and return the job. */
import { cancelImageJobContract, NotFoundError } from '@bike4mind/common';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { cancelOwnGenerationJob } from '@server/generations/cancelOwnGenerationJob';
import { findOwnGenerationJob } from '@bike4mind/server-utils/generations/findOwnGenerationJob';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';
import { mapperDeps } from '@server/generations/routeDeps';
import { IMAGE_GENERATION_PROJECTION, toPublicGenerationJob } from '@server/generations/toPublicGenerationJob';

const handler = nextRouteForContract(cancelImageJobContract, {
  rateLimit: perUserRateLimit('POST /api/v1/image-jobs/[id]/cancel'),
}).post(async (req, res) => {
  const job = await findOwnGenerationJob(req.validatedParams.id, req.user.id, 'image');
  if (!job) throw new NotFoundError('Image job not found');
  return res.json(
    await toPublicGenerationJob(await cancelOwnGenerationJob(job), mapperDeps, IMAGE_GENERATION_PROJECTION)
  );
});

export const config = {
  api: { externalResolver: true },
};

export default handler;
