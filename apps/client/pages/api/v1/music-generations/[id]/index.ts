/** GET /api/v1/music-generations/{id} - one job the caller requested; anything else is a 404. */
import { getMusicGenerationContract, NotFoundError } from '@bike4mind/common';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { findOwnGenerationJob } from '@server/generations/findOwnGenerationJob';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';
import { mapperDeps } from '@server/generations/routeDeps';
import { toPublicMusicGeneration } from '@server/musicGenerations/toPublicMusicGeneration';

const handler = nextRouteForContract(getMusicGenerationContract, {
  // Clients poll this until the job is terminal; polling must not drain the daily request budget.
  exemptReadsFromDailyRateLimit: true,
  rateLimit: perUserRateLimit('GET /api/v1/music-generations/[id]'),
}).get(async (req, res) => {
  const job = await findOwnGenerationJob(req.validatedParams.id, req.user.id, 'music');
  if (!job) throw new NotFoundError('Music generation not found');
  return res.json(await toPublicMusicGeneration(job, mapperDeps));
});

export const config = {
  api: { externalResolver: true },
};

export default handler;
