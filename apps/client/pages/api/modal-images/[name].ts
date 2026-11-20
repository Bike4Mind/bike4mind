import { ModalModel } from '@bike4mind/database';
import { NotFoundError } from '@bike4mind/common';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { getFilesStorage } from '@bike4mind/server-utils/utils/storage/index';
import { baseApi } from '@server/middlewares/baseApi';
import { MODAL_IMAGE_PREFIX } from '@client/server/tools/modalImageUrls';

const NAME_RE = /^[0-9a-f-]{36}\.[a-z0-9]{2,5}$/;
// Seconds. Shorter than the signature, so a cached redirect never outlives the URL it points to.
const SIGNED_URL_TTL_SECONDS = 900;
const CACHE_CONTROL = 'public, max-age=300';

// Stable, unauthenticated URL for a modal image, used where a signed URL would expire (emailed HTML).
const handler = baseApi({ auth: false, allowedMethods: ['GET'] })
  .use(rateLimit({ limit: 300, windowMs: 60_000, bucket: 'GET /api/modal-images' }))
  .get(async (req, res) => {
    const name = req.query.name;
    if (typeof name !== 'string' || !NAME_RE.test(name)) throw new NotFoundError('Image not found');

    const key = `${MODAL_IMAGE_PREFIX}${name}`;
    if (!(await ModalModel.exists({ imageUrl: key }))) throw new NotFoundError('Image not found');

    const signed = await getFilesStorage().getSignedUrl(key, 'get', {
      expiresIn: SIGNED_URL_TTL_SECONDS,
      audience: 'browser',
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
