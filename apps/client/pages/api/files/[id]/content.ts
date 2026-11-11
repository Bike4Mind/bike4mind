import { isImageServeable, NotFoundError } from '@bike4mind/common';
import { fabFileRepository } from '@bike4mind/database';
import { FILE_URL_TTL_SECONDS, signedUrlExpiresAt, verifyFileContentSig } from '@bike4mind/utils';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { getClientIp } from '@bike4mind/server-utils/utils/ip';
import { isValidObjectId } from '@bike4mind/server-utils/utils/objectId';
import { getFilesStorage } from '@bike4mind/server-utils/utils/storage/index';
import { baseApi } from '@server/middlewares/baseApi';
import { fileContentKey } from '@server/files/browserFileSigner';

// Seconds. The redirect must go stale before the S3 link it points at does.
const REDIRECT_SAFETY_MARGIN_SECONDS = 60;
const MAX_REDIRECT_CACHE_SECONDS = 1800;

/**
 * The stable browser URL fabFileService's generateSignedUrl hands out (apps/client/server/files/browserFileSigner.ts).
 * The sig is the capability, so there is no session auth; it 302s to an S3 link signed now, and the
 * redirect is cacheable so repeat loads of the same URL never reach this route.
 */
const handler = baseApi({ auth: false, allowedMethods: ['GET'] })
  // Counted per IP per file, so a grid behind one NAT does not share a single bucket.
  .use(
    rateLimit({
      limit: 1000,
      windowMs: 60_000,
      bucket: 'GET /api/files/[id]/content',
      subject: req => `${getClientIp(req)}:${String(req.query.id)}`,
    })
  )
  .get(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const notFound = new NotFoundError('File not found');
    const id = req.query.id;
    if (!isValidObjectId(id)) throw notFound;

    const fabFile = await fabFileRepository.findById(id);
    if (!fabFile || fabFile.deletedAt || !fabFile.filePath) throw notFound;
    const check = verifyFileContentSig(
      { fileId: id, filePath: fabFile.filePath, exp: req.query.exp, sig: req.query.sig },
      fileContentKey()
    );
    if (!check.ok || !isImageServeable(fabFile)) throw notFound;

    const nowSeconds = Math.floor(Date.now() / 1000);
    const signed = await getFilesStorage().getSignedUrl(fabFile.filePath, 'get', {
      expiresIn: Math.max(60, Math.min(FILE_URL_TTL_SECONDS, check.exp - nowSeconds)),
      audience: 'browser',
    });
    const s3ExpirySeconds = signedUrlExpiresAt(signed, FILE_URL_TTL_SECONDS).getTime() / 1000;
    const maxAge = Math.max(
      0,
      Math.min(
        MAX_REDIRECT_CACHE_SECONDS,
        Math.floor(Math.min(check.exp, s3ExpirySeconds) - nowSeconds - REDIRECT_SAFETY_MARGIN_SECONDS)
      )
    );
    res.setHeader('Cache-Control', maxAge > 0 ? `private, max-age=${maxAge}` : 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.redirect(302, signed);
  });

export default handler;

export const config = {
  api: {
    externalResolver: true,
  },
};
