// apps/client/pages/api/skills/market/[id]/template/image/from-generation.ts
import { baseApi } from '@client/server/middlewares/baseApi';
import { SkillTemplateImageFromGenerationSchema } from '@bike4mind/common';
import { setOwnTemplateImageFromGeneration } from '@server/skillMarket/templateImage';

/**
 * POST /api/skills/market/[id]/template/image/from-generation - use the image of one of the author's
 * own finished image generations (from ./generate). Stored again at 1200x630 and starts unapproved.
 */
const handler = baseApi({ auth: 'jwtOnly' }).post(async (req, res) => {
  const { questId } = SkillTemplateImageFromGenerationSchema.parse(req.body ?? {});
  res.json({ template: await setOwnTemplateImageFromGeneration(req.user!, String(req.query.id), questId) });
});

export default handler;
