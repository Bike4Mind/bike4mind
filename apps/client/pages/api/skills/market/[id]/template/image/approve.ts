// apps/client/pages/api/skills/market/[id]/template/image/approve.ts
import { baseApi } from '@client/server/middlewares/baseApi';
import { approveOwnTemplateImage } from '@server/skillMarket/templateImage';

/**
 * POST /api/skills/market/[id]/template/image/approve - the author approves the current preview image,
 * which publishing requires. Draft templates only.
 */
const handler = baseApi({ auth: 'jwtOnly' }).post(async (req, res) => {
  res.json({ template: await approveOwnTemplateImage(req.user!, String(req.query.id)) });
});

export default handler;
