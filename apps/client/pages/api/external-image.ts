import { HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { isExecutableUploadMimeType } from '@bike4mind/common';
import { createS3Client } from '@bike4mind/fab-pipeline';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError, ForbiddenError } from '@server/utils/errors';
import { assertUrlAllowed, safeFetch, SsrfError } from '@server/utils/ssrfProtection';
import { streamWithSizeLimit } from '@server/utils/streamWithSizeLimit';
import { Resource } from 'sst';
import crypto from 'crypto';
import { z } from 'zod';

// Was previously a raw NextApiRequest with ZERO auth and no URL validation:
// an open SSRF proxy that fetched any URL the caller asked for, including
// internal/metadata addresses, and uploaded the result to a public S3 prefix.
//
// Now:
//   1. Requires admin authentication (the only legitimate caller is the admin
//      modal in AdminModalTabNew.tsx).
//   2. Validates the URL is https:// and rejects private/loopback/link-local
//      hosts to neutralise classic SSRF (cloud metadata, internal services).
//   3. Caps response size via streaming abort and validates content-type is image/*.
//   4. Follows at most one redirect with SSRF re-check on the Location header
//      to support Gravatar, GitHub avatars, and other CDN redirects.

const s3Client = createS3Client();

const ExternalImageQuery = z.object({
  url: z.string().url('url must be a valid URL'),
});

const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB
const FETCH_TIMEOUT_MS = 10_000;

function generateCacheKey(rawUrl: string, parsed: URL): string {
  const hash = crypto.createHash('sha256').update(rawUrl).digest('hex');
  const ext = parsed.pathname.split('.').pop()?.split('?')[0] || 'jpg';
  // Constrain extension to a small safe set
  const safeExt = /^[a-z0-9]{1,5}$/i.test(ext) ? ext : 'jpg';
  return `proxied-images/${hash}.${safeExt}`;
}

const handler = baseApi().get(
  asyncHandler(async (req, res) => {
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Admin only');
    }

    const { url: rawUrl } = ExternalImageQuery.parse(req.query);
    const brand = process.env.APP_NAME || '';

    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      throw new BadRequestError('url must be a valid URL');
    }

    try {
      await assertUrlAllowed(parsed.toString());
    } catch (e) {
      if (e instanceof SsrfError) {
        req.logger.warn('Blocked SSRF attempt on /api/external-image', { url: rawUrl, reason: e.message });
        throw new BadRequestError(e.message);
      }
      throw e;
    }

    const bucketName = Resource.appFilesBucket.name;
    const cacheKey = generateCacheKey(rawUrl, parsed);

    // Check if image already exists in S3
    try {
      await s3Client.send(new HeadObjectCommand({ Bucket: bucketName, Key: cacheKey }));
      const s3Url = `${process.env.NEXT_PUBLIC_CDN_URL}/${cacheKey}`;
      return res.redirect(302, s3Url);
    } catch (headError: unknown) {
      if ((headError as { name?: string })?.name !== 'NotFound') {
        throw headError;
      }
    }

    // Download with timeout
    req.logger.info('Downloading external image', { url: rawUrl });
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    let response: Response;
    try {
      // safeFetch re-checks the initial host and follows at most one redirect after
      // re-validating its Location through the SSRF guard, so legitimate CDN redirects
      // (Gravatar, GitHub avatars, Cloudinary) still work while a redirect to a private
      // host is blocked.
      response = await safeFetch(parsed.toString(), {
        headers: {
          'User-Agent': `Lumina5-ImageProxy/1.0${brand ? ` (${brand})` : ''}`,
          Accept: 'image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        },
        signal: controller.signal,
      });
    } catch (fetchError) {
      if (fetchError instanceof SsrfError) {
        req.logger.warn('Blocked SSRF on external image fetch', { url: rawUrl, reason: fetchError.message });
        throw new BadRequestError(fetchError.message);
      }
      if (fetchError instanceof Error && fetchError.name === 'AbortError') {
        throw new BadRequestError('Image fetch timed out');
      }
      throw fetchError;
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      throw new BadRequestError(`Failed to fetch image: ${response.status}`);
    }

    // Validate content type is an image
    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    // image/svg+xml passes startsWith('image/') but is an executable document when served
    // back from our public CDN prefix - reject it (and any other executable type) explicitly.
    if (!contentType.startsWith('image/') || isExecutableUploadMimeType(contentType)) {
      req.logger.warn('Rejected non-image content-type', { url: rawUrl, contentType });
      throw new BadRequestError('Response is not an image');
    }

    // Stream the body with an early-abort size check instead of
    // buffering with arrayBuffer(). A malicious server can omit Content-Length
    // and stream arbitrarily; the old post-buffer check could OOM first.
    const buffer = await streamWithSizeLimit(response, MAX_IMAGE_BYTES);

    await s3Client.send(
      new PutObjectCommand({
        Bucket: bucketName,
        Key: cacheKey,
        Body: buffer,
        ContentType: contentType,
        CacheControl: 'public, max-age=31536000',
      })
    );

    const s3Url = `${process.env.NEXT_PUBLIC_CDN_URL}/${cacheKey}`;
    req.logger.info('External image cached to S3', { cacheKey });
    return res.redirect(302, s3Url);
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
