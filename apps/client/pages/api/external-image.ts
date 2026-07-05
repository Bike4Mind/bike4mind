import { HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError, ForbiddenError } from '@server/utils/errors';
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

const s3Client = new S3Client({});

const ExternalImageQuery = z.object({
  url: z.string().url('url must be a valid URL'),
});

const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB
const FETCH_TIMEOUT_MS = 10_000;

/**
 * SSRF guard. Returns null if the URL is safe to fetch, otherwise a reason.
 *
 * Note: this is a hostname-string check, not a DNS-resolved IP check, so it
 * does not defend against DNS rebinding. The admin-only gate is the primary
 * control; this is defence in depth.
 */
function rejectIfUnsafe(url: URL): string | null {
  if (url.protocol !== 'https:') {
    return 'only https URLs are allowed';
  }

  // Normalize: strip square brackets from IPv6 notation so the same checks
  // work for both `::1` and `[::1]` forms returned by URL.hostname.
  const raw = url.hostname.toLowerCase();
  const host = raw.startsWith('[') && raw.endsWith(']') ? raw.slice(1, -1) : raw;

  // Reject literal loopback / unspecified
  if (host === 'localhost' || host === '0.0.0.0' || host === '::' || host === '::1') {
    return 'loopback hosts are not allowed';
  }

  // Reject IPv4-mapped IPv6 addresses (::ffff:a.b.c.d / ::ffff:hex:hex).
  // Node normalises these to ::ffff:XXYY:ZZWW which bypasses the IPv4 regex but
  // fetch() still dials the underlying IPv4 address.
  if (host.includes('ffff:')) {
    return 'IPv4-mapped IPv6 addresses are not allowed';
  }

  // Reject IPv4 in private / loopback / link-local ranges
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = [parseInt(ipv4[1], 10), parseInt(ipv4[2], 10)];
    if (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) || // link-local + AWS metadata 169.254.169.254
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224 // multicast / reserved
    ) {
      return 'private/reserved IPv4 addresses are not allowed';
    }
  }

  // Reject IPv6 unique-local (fc00::/7) and link-local (fe80::/10)
  if (
    host.startsWith('fc') ||
    host.startsWith('fd') ||
    host.startsWith('fe8') ||
    host.startsWith('fe9') ||
    host.startsWith('fea') ||
    host.startsWith('feb')
  ) {
    return 'private/reserved IPv6 addresses are not allowed';
  }

  return null;
}

function generateCacheKey(rawUrl: string, parsed: URL): string {
  const hash = crypto.createHash('sha256').update(rawUrl).digest('hex');
  const ext = parsed.pathname.split('.').pop()?.split('?')[0] || 'jpg';
  // Constrain extension to a small safe set
  const safeExt = /^[a-z0-9]{1,5}$/i.test(ext) ? ext : 'jpg';
  return `proxied-images/${hash}.${safeExt}`;
}

/**
 * Stream the response body and abort as soon as the size cap is
 * exceeded, rather than buffering with arrayBuffer() which can OOM the Lambda
 * before the post-check fires when Content-Length is omitted or lies.
 */
async function streamWithSizeLimit(response: Response, maxBytes: number): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) throw new BadRequestError('No response body');

  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel();
        throw new BadRequestError('Image too large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
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

    const reject = rejectIfUnsafe(parsed);
    if (reject) {
      req.logger.warn('Blocked SSRF attempt on /api/external-image', { url: rawUrl, reason: reject });
      throw new BadRequestError(reject);
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
      // Use redirect: 'manual' instead of redirect: 'error' so we
      // can follow legitimate CDN redirects (Gravatar, GitHub avatars, Cloudinary)
      // after re-checking the Location header through the SSRF guard. This closes
      // the redirect-to-private-host bypass without breaking real image hosts.
      response = await fetch(parsed.toString(), {
        headers: {
          'User-Agent': `Lumina5-ImageProxy/1.0${brand ? ` (${brand})` : ''}`,
          Accept: 'image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        },
        signal: controller.signal,
        redirect: 'manual',
      });

      // Follow at most one redirect, re-checking the target through the SSRF guard
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) {
          throw new BadRequestError('Redirect without Location header');
        }
        const redirectUrl = new URL(location, parsed);
        const redirectReject = rejectIfUnsafe(redirectUrl);
        if (redirectReject) {
          req.logger.warn('Blocked SSRF via redirect', {
            from: rawUrl,
            to: redirectUrl.toString(),
            reason: redirectReject,
          });
          throw new BadRequestError(`Blocked redirect: ${redirectReject}`);
        }
        // Second fetch with redirect: 'error' to prevent further hops
        response = await fetch(redirectUrl.toString(), {
          headers: {
            'User-Agent': `Lumina5-ImageProxy/1.0${brand ? ` (${brand})` : ''}`,
            Accept: 'image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
          },
          signal: controller.signal,
          redirect: 'error',
        });
      }
    } catch (fetchError) {
      if (fetchError instanceof BadRequestError) throw fetchError;
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
    if (!contentType.startsWith('image/')) {
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
