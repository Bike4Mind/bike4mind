/** GET /api/v1/music-models - the music models this caller can use right now. */
import { listMusicModelsContract } from '@bike4mind/common';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { getMusicJobDeps } from '@server/generationJobs/wiring';
import { listUsableMusicModels } from '@bike4mind/server-utils/musicGenerations/listUsableMusicModels';
import { filterAdmittedMediaModels } from '@server/billing/assertMediaModelAdmission';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';

const handler = nextRouteForContract(listMusicModelsContract, {
  exemptReadsFromDailyRateLimit: true,
  rateLimit: perUserRateLimit('GET /api/v1/music-models'),
}).get(async (req, res) =>
  res.json({
    models: await filterAdmittedMediaModels(req.user, await listUsableMusicModels(req.user.id, getMusicJobDeps())),
  })
);

export const config = {
  api: { externalResolver: true },
};

export default handler;
