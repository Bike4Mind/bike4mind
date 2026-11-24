// apps/client/pages/api/skills/market/[id]/template/image/from-generation.ts
import { baseApi } from '@client/server/middlewares/baseApi';
import { SkillTemplateImageFromGenerationSchema } from '@bike4mind/common';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { resolveUserRateLimitPerMin } from '@bike4mind/server-utils/utils/userRateTier';
import { setOwnTemplateImageFromGeneration } from '@server/skillMarket/templateImage';

const HOUR_MS = 60 * 60 * 1000;

/**
 * POST /api/skills/market/[id]/template/image/from-generation - use the image of one of the author's
 * own finished image generations (from ./generate). Stored again at 1200x630 and starts unapproved.
 */
const handler = baseApi({ auth: 'jwtOnly' }).post(
  rateLimit({
    limit: async req => ((await resolveUserRateLimitPerMin(req.user, req)) > 0 ? 30 : 0),
    windowMs: HOUR_MS,
    bucket: 'skill-market-template-image-from-generation',
  }),
  async (req, res) => {
    const { questId } = SkillTemplateImageFromGenerationSchema.parse(req.body ?? {});
    res.json({ template: await setOwnTemplateImageFromGeneration(req.user!, String(req.query.id), questId) });
  }
);

export default handler;
