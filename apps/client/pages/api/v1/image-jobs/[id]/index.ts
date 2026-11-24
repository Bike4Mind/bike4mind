/** GET /api/v1/image-jobs/{id} - one job the caller requested; anything else is a 404. */
import { getImageJobContract, NotFoundError } from '@bike4mind/common';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { findOwnGenerationJob } from '@bike4mind/server-utils/generations/findOwnGenerationJob';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';
import { mapperDeps } from '@server/generations/routeDeps';
import { IMAGE_GENERATION_PROJECTION, toPublicGenerationJob } from '@server/generations/toPublicGenerationJob';

const handler = nextRouteForContract(getImageJobContract, {
  // Clients poll this until the job is terminal; polling must not drain the daily request budget.
  exemptReadsFromDailyRateLimit: true,
  rateLimit: perUserRateLimit('GET /api/v1/image-jobs/[id]'),
}).get(async (req, res) => {
  const job = await findOwnGenerationJob(req.validatedParams.id, req.user.id, 'image');
  if (!job) throw new NotFoundError('Image job not found');
  return res.json(await toPublicGenerationJob(job, mapperDeps, IMAGE_GENERATION_PROJECTION));
});

export const config = {
  api: { externalResolver: true },
};

export default handler;
