/** POST /api/v1/music-generations/{id}/cancel - request cancellation and return the job. */
import { cancelMusicGenerationContract, NotFoundError } from '@bike4mind/common';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { cancelOwnGenerationJob } from '@server/generations/cancelOwnGenerationJob';
import { findOwnGenerationJob } from '@server/generations/findOwnGenerationJob';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';
import { mapperDeps } from '@server/generations/routeDeps';
import { MUSIC_GENERATION_PROJECTION, toPublicGenerationJob } from '@server/generations/toPublicGenerationJob';

const handler = nextRouteForContract(cancelMusicGenerationContract, {
  rateLimit: perUserRateLimit('POST /api/v1/music-generations/[id]/cancel'),
}).post(async (req, res) => {
  const job = await findOwnGenerationJob(req.validatedParams.id, req.user.id, 'music');
  if (!job) throw new NotFoundError('Music generation not found');
  return res.json(
    await toPublicGenerationJob(await cancelOwnGenerationJob(job), mapperDeps, MUSIC_GENERATION_PROJECTION)
  );
});

export const config = {
  api: { externalResolver: true },
};

export default handler;
