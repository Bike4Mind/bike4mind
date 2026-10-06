/** GET /api/v1/video-models - the video models this caller can use right now. */
import { listVideoModelsContract } from '@bike4mind/common';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { getVideoJobDeps } from '@server/generationJobs/wiring';
import { listUsableVideoModels } from '@server/videoGenerations/listUsableVideoModels';
import { perUserRateLimit } from '@server/videoGenerations/routeDeps';

const handler = nextRouteForContract(listVideoModelsContract, {
  exemptReadsFromDailyRateLimit: true,
  rateLimit: perUserRateLimit('/api/v1/video-models'),
}).get(async (req, res) => res.json({ models: await listUsableVideoModels(req.user.id, getVideoJobDeps()) }));

export const config = {
  api: { externalResolver: true },
};

export default handler;
