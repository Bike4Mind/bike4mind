// apps/client/pages/api/skills/market/[id]/template/image/index.ts
import { Request } from 'express';
import { baseApi } from '@client/server/middlewares/baseApi';
import { SkillTemplateImageUploadSchema } from '@bike4mind/common';
import { removeOwnTemplateImage, setOwnTemplateImageFromUpload } from '@server/skillMarket/templateImage';

/** The template preview image (see server/skillMarket/templateImage.ts). Author only, draft templates only. */
const handler = baseApi({ auth: 'jwtOnly' })
  /**
   * PUT /api/skills/market/[id]/template/image - use a screenshot the author uploaded as a file. It is
   * stored again at 1200x630 and starts unapproved.
   */
  .put(async (req, res) => {
    const { fabFileId } = SkillTemplateImageUploadSchema.parse(req.body ?? {});
    res.json({ template: await setOwnTemplateImageFromUpload(req.user!, String(req.query.id), fabFileId) });
  })
  /** DELETE /api/skills/market/[id]/template/image - remove the preview image. */
  .delete<Request<{}, {}, {}, { id: string }>>(async (req, res) => {
    res.json({ template: await removeOwnTemplateImage(req.user!, String(req.query.id)) });
  });

export default handler;
