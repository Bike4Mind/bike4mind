// apps/client/pages/api/skills/market/[id]/template/example.ts
import { baseApi } from '@client/server/middlewares/baseApi';
import { SkillTemplateExampleRunSchema, SkillTemplateExampleUpdateSchema } from '@bike4mind/common';
import { assertAiAccessAllowed } from '@bike4mind/server-utils/auth/assertAiAccessAllowed';
import {
  TEMPLATE_EXAMPLE_DISPATCH_PATH,
  editOwnTemplateExample,
  startOwnTemplateExample,
  templateExampleDispatchIdentity,
} from '@server/skillMarket/templateExample';
import { dispatchSigned } from '@server/utils/dispatchQuest';

/** The template's example run (server/skillMarket/templateExample.ts). Author only. */
const handler = baseApi({ auth: 'jwtOnly' })
  /**
   * POST /api/skills/market/[id]/template/example - run or re-run the example on the platform's keys.
   * 202 with the template while it runs; 429 once the author's daily runs are spent.
   */
  .post(async (req, res) => {
    const user = req.user!;
    assertAiAccessAllowed(user);
    const body = SkillTemplateExampleRunSchema.parse(req.body ?? {});
    const template = await startOwnTemplateExample(user, String(req.query.id), body, {
      dispatch: payload =>
        dispatchSigned(TEMPLATE_EXAMPLE_DISPATCH_PATH, templateExampleDispatchIdentity(payload), payload, req.logger),
    });
    res.status(202).json({ template });
  })
  /** PUT /api/skills/market/[id]/template/example - the demo switch, a reply trim or the sample file. */
  .put(async (req, res) => {
    const body = SkillTemplateExampleUpdateSchema.parse(req.body ?? {});
    res.json({ template: await editOwnTemplateExample(req.user!, String(req.query.id), body) });
  });

export default handler;
