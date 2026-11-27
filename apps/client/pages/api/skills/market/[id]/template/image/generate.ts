// apps/client/pages/api/skills/market/[id]/template/image/generate.ts
import { baseApi } from '@client/server/middlewares/baseApi';
import { GenerateImageIvokeParamsSchema, SkillTemplateImageGenerateSchema } from '@bike4mind/common';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { resolveUserRateLimitPerMin } from '@bike4mind/server-utils/utils/userRateTier';
import { assertAiAccessAllowed } from '@bike4mind/server-utils/auth/assertAiAccessAllowed';
import { getImageGeneration } from '@bike4mind/server-utils/imageGenerations/imageGeneration';
import { getOrCreateSession } from '@bike4mind/server-utils/managers/sessionManager';
import { resolveMediaBillingOrgId } from '@server/billing/resolveMediaBillingOrgId';
import { resolveSessionOrigin } from '@server/managers/sessionOrigin';
import {
  TEMPLATE_IMAGE_ASPECT_RATIO,
  TEMPLATE_IMAGE_MODEL,
  prepareTemplateImageGeneration,
} from '@server/skillMarket/templateImage';

const HOUR_MS = 60 * 60 * 1000;

/**
 * POST /api/skills/market/[id]/template/image/generate - queue a preview image generation from the
 * template headline and a pasted real result. It is the author's own image generation in a new
 * notebook, set up and charged like POST /api/v1/image-generations. The editor polls the returned
 * quest, then hands it to ./from-generation.
 */
const handler = baseApi({ auth: 'jwtOnly' })
  .use(
    rateLimit({
      limit: async req => ((await resolveUserRateLimitPerMin(req.user, req)) > 0 ? 10 : 0),
      windowMs: HOUR_MS,
      bucket: 'skill-market-template-image',
    })
  )
  .post(async (req, res) => {
    const user = req.user!;
    assertAiAccessAllowed(user);
    const { result } = SkillTemplateImageGenerateSchema.parse(req.body ?? {});
    const { prompt, sessionName } = await prepareTemplateImageGeneration(user, String(req.query.id), result);

    // Before the notebook is created, so a refused payer leaves nothing behind.
    const organizationId = await resolveMediaBillingOrgId(req, undefined);
    const { sessionId, asyncPromises } = await getOrCreateSession({
      sessionName,
      user,
      ability: req.ability,
      logger: req.logger,
      origin: resolveSessionOrigin(req),
    });
    const quest = await getImageGeneration().invoke({
      userId: user.id,
      body: GenerateImageIvokeParamsSchema.parse({
        model: TEMPLATE_IMAGE_MODEL,
        prompt,
        aspect_ratio: TEMPLATE_IMAGE_ASPECT_RATIO,
        n: 1,
        sessionId,
        organizationId,
        intent: 'fresh',
      }),
    });
    await Promise.all(asyncPromises);
    res.json({ questId: quest.id });
  });

export default handler;
