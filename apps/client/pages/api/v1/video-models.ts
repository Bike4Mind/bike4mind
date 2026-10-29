import { filterAdmittedMediaModels } from '@server/billing/assertMediaModelAdmission';
/** GET /api/v1/video-models - the video models this caller can use right now. */
import { listVideoModelsContract } from '@bike4mind/common';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { getVideoJobDeps } from '@server/generationJobs/wiring';
import { listUsableVideoModels } from '@bike4mind/server-utils/videoGenerations/listUsableVideoModels';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';

const handler = nextRouteForContract(listVideoModelsContract, {
  exemptReadsFromDailyRateLimit: true,
  rateLimit: perUserRateLimit('GET /api/v1/video-models'),
}).get(async (req, res) =>
  res.json({
    models: await filterAdmittedMediaModels(req.user, await listUsableVideoModels(req.user.id, getVideoJobDeps())),
  })
);

export const config = {
  api: { externalResolver: true },
};

export default handler;
