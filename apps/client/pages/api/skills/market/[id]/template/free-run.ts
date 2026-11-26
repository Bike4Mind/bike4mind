// apps/client/pages/api/skills/market/[id]/template/free-run.ts
import { baseApi } from '@client/server/middlewares/baseApi';
import { SkillTemplateFreeRunSchema } from '@bike4mind/common';
import { setOwnTemplateFreeRun } from '@server/skillMarket/template';

/**
 * PUT /api/skills/market/[id]/template/free-run - switch the template's free run. Turning it on is
 * refused (409, with the reason) when the approved version uses tools or supporting files.
 */
const handler = baseApi({ auth: 'jwtOnly' }).put(async (req, res) => {
  const { enabled } = SkillTemplateFreeRunSchema.parse(req.body ?? {});
  res.json({ template: await setOwnTemplateFreeRun(req.user!, String(req.query.id), enabled) });
});

export default handler;
