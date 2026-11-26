// apps/client/pages/api/skills/market/[id]/template/image/index.ts
import { Request } from 'express';
import { baseApi } from '@client/server/middlewares/baseApi';
import { SkillTemplateImageUploadSchema } from '@bike4mind/common';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { resolveUserRateLimitPerMin } from '@bike4mind/server-utils/utils/userRateTier';
import { removeOwnTemplateImage, setOwnTemplateImageFromUpload } from '@server/skillMarket/templateImage';

const HOUR_MS = 60 * 60 * 1000;

/** The template preview image (see server/skillMarket/templateImage.ts). Author only, draft templates only. */
const handler = baseApi({ auth: 'jwtOnly' })
  /**
   * PUT /api/skills/market/[id]/template/image - use a screenshot the author uploaded as a file. It is
   * stored again at 1200x630 and starts unapproved.
   */
  .put(
    rateLimit({
      limit: async req => ((await resolveUserRateLimitPerMin(req.user, req)) > 0 ? 30 : 0),
      windowMs: HOUR_MS,
      bucket: 'skill-market-template-image-upload',
    }),
    async (req, res) => {
      const { fabFileId } = SkillTemplateImageUploadSchema.parse(req.body ?? {});
      res.json({ template: await setOwnTemplateImageFromUpload(req.user!, String(req.query.id), fabFileId) });
    }
  )
  /** DELETE /api/skills/market/[id]/template/image - remove the preview image. */
  .delete<Request<{}, {}, {}, { id: string }>>(async (req, res) => {
    res.json({ template: await removeOwnTemplateImage(req.user!, String(req.query.id)) });
  });

export default handler;
