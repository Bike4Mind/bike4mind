// apps/client/pages/api/skills/market/[id]/template/index.ts
import { Request } from 'express';
import { baseApi } from '@client/server/middlewares/baseApi';
import { SkillTemplateUpdateSchema } from '@bike4mind/common';
import { enforceSubmitRateLimits } from '@bike4mind/server-utils/skillMarket/market';
import { getOperationsClassifierLlm } from '@server/skillMarket/classifySkill';
import { deleteOwnTemplate, getOwnTemplate, saveOwnTemplate } from '@server/skillMarket/template';

/** The listing author's template page (see server/skillMarket/template.ts). Author only. */
const handler = baseApi({ auth: 'jwtOnly' })
  /** GET /api/skills/market/[id]/template - the template, or `{ template: null }` before one is saved. */
  .get<Request<{}, {}, {}, { id: string }>>(async (req, res) => {
    res.json({ template: await getOwnTemplate(req.user!, String(req.query.id)) });
  })
  /**
   * PUT /api/skills/market/[id]/template - create the template or edit its copy. Editing a published
   * template's copy re-runs the scan, so that path draws on the market's submit rate limits.
   */
  .put(async (req, res) => {
    const body = SkillTemplateUpdateSchema.parse(req.body ?? {});
    const template = await saveOwnTemplate(req.user!, String(req.query.id), body, {
      beforeScan: () => enforceSubmitRateLimits(req, res),
      getClassifier: () => getOperationsClassifierLlm(req.logger, req.user!.id),
    });
    res.json({ template });
  })
  /** DELETE /api/skills/market/[id]/template - delete the template. */
  .delete<Request<{}, {}, {}, { id: string }>>(async (req, res) => {
    await deleteOwnTemplate(req.user!, String(req.query.id));
    res.status(204).end();
  });

export default handler;
