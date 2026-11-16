/** GET /api/v1/image-models - the image models this caller can use right now, best first. */
import { listImageModelsContract } from '@bike4mind/common';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { getCallerModelList } from '@server/utils/callerModelList';
import { getImageJobDeps } from '@bike4mind/server-utils/generationJobs/wiring';
import { listUsableImageModels } from '@bike4mind/server-utils/imageGenerations/listUsableImageModels';
import { filterAdmittedMediaModels } from '@bike4mind/server-utils/billing/assertMediaModelAdmission';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';

const handler = nextRouteForContract(listImageModelsContract, {
  exemptReadsFromDailyRateLimit: true,
  rateLimit: perUserRateLimit('GET /api/v1/image-models'),
}).get(async (req, res) => {
  // The caller's model list carries what the catalog cannot: admin-disabled, deprecated and plan-locked models.
  const { models } = await getCallerModelList(req.user, req.logger);
  const offered = models.filter(model => model.type === 'image' && !model.disabled);
  res.json({
    models: await filterAdmittedMediaModels(
      req.user,
      await listUsableImageModels(req.user.id, offered, getImageJobDeps())
    ),
  });
});

export const config = {
  api: { externalResolver: true },
};

export default handler;
