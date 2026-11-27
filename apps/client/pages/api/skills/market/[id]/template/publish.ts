// apps/client/pages/api/skills/market/[id]/template/publish.ts
import { Request } from 'express';
import { baseApi } from '@client/server/middlewares/baseApi';
import { enforceSubmitRateLimits } from '@bike4mind/server-utils/skillMarket/market';
import { getOperationsClassifierLlm } from '@server/skillMarket/classifySkill';
import { publishOwnTemplate, unpublishOwnTemplate } from '@server/skillMarket/template';

const handler = baseApi({ auth: 'jwtOnly' })
  /**
   * POST /api/skills/market/[id]/template/publish - scan the template copy and publish it on a pass.
   * A failing scan answers 200 with the template back in draft and its findings, as a scanned
   * listing version does. Draws on the market's submit rate limits, since each scan may call a model.
   */
  .post(async (req, res) => {
    await enforceSubmitRateLimits(req, res);
    const template = await publishOwnTemplate(req.user!, String(req.query.id), {
      getClassifier: () => getOperationsClassifierLlm(req.logger, req.user!.id),
    });
    res.json({ template });
  })
  /** DELETE /api/skills/market/[id]/template/publish - take the template page down. */
  .delete<Request<{}, {}, {}, { id: string }>>(async (req, res) => {
    res.json({ template: await unpublishOwnTemplate(req.user!, String(req.query.id)) });
  });

export default handler;
