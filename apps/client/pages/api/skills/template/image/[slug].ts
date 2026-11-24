import {
  NotFoundError,
  SKILL_TEMPLATE_SLUG_MAX,
  SKILL_TEMPLATE_SLUG_PATTERN,
  isImageServeable,
} from '@bike4mind/common';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { getFilesStorage } from '@bike4mind/server-utils/utils/storage/index';
import { storageReadOverrides } from '@bike4mind/utils/contentDisposition';
import { baseApi } from '@server/middlewares/baseApi';
import { findPublicTemplateImage } from '@server/skillMarket/templateImage';

// Seconds. Shorter than the signature, so a cached redirect never outlives the URL it points to.
const SIGNED_URL_TTL_SECONDS = 900;
const CACHE_CONTROL = 'public, max-age=300';

/**
 * GET /api/skills/template/image/[slug] - a published template's approved preview image, at a stable
 * unauthenticated URL that link-preview fetchers can load (skillTemplatePreviewImagePath builds it).
 * Modeled on pages/api/modal-images/[name].ts.
 */
const handler = baseApi({ auth: false, allowedMethods: ['GET'] })
  .use(rateLimit({ limit: 300, windowMs: 60_000, bucket: 'GET /api/skills/template/image' }))
  .get(async (req, res) => {
    const slug = req.query.slug;
    if (typeof slug !== 'string' || slug.length > SKILL_TEMPLATE_SLUG_MAX || !SKILL_TEMPLATE_SLUG_PATTERN.test(slug)) {
      throw new NotFoundError('Image not found');
    }

    const image = await findPublicTemplateImage(slug);
    if (!image || !isImageServeable(image)) throw new NotFoundError('Image not found');

    const signed = await getFilesStorage().getSignedUrl(image.filePath, 'get', {
      expiresIn: SIGNED_URL_TTL_SECONDS,
      audience: 'browser',
      // Server-encoded JPEG, so the inline image type is safe to pin.
      ...storageReadOverrides({ mimeType: image.mimeType, key: image.filePath }),
    });
    res.setHeader('Cache-Control', CACHE_CONTROL);
    res.setHeader('Referrer-Policy', 'no-referrer');
    return res.redirect(302, signed);
  });

export default handler;

export const config = {
  api: {
    externalResolver: true,
  },
};
