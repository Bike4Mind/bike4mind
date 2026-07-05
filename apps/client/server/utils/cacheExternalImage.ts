import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { Resource } from 'sst';
import crypto from 'crypto';
import { withRetry, isRetryableError } from '@bike4mind/utils';
import { validateTargetUrl } from './ssrfProtection';

const s3Client = new S3Client({});

// Generate a deterministic key from the URL for caching
function generateCacheKey(url: string): string {
  const hash = crypto.createHash('sha256').update(url).digest('hex');
  const ext = url.split('.').pop()?.split('?')[0] || 'jpg';
  return `proxied-images/${hash}.${ext}`;
}

/**
 * Cache an external image to S3 and return the S3 URL
 * @param url - The external image URL
 * @returns The S3 URL if the image was cached, or the original URL if it's already an S3 URL
 */
export async function cacheExternalImage(url: string): Promise<string> {
  // Skip if already an S3 URL
  if (url.includes('amazonaws.com')) {
    return url;
  }

  // Skip if not an HTTP URL
  if (!url.startsWith('http')) {
    return url;
  }

  // SSRF protection: block private/internal/metadata URLs (async resolves DNS to catch rebinding)
  const ssrfCheck = await validateTargetUrl(url);
  if (!ssrfCheck.valid) {
    console.warn(`[SSRF] Blocked image fetch to unsafe URL: ${url} (${ssrfCheck.error})`);
    return url;
  }

  try {
    const bucketName = Resource.appFilesBucket.name;
    const cacheKey = generateCacheKey(url);

    // Check if image already exists in S3
    try {
      await s3Client.send(
        new HeadObjectCommand({
          Bucket: bucketName,
          Key: cacheKey,
        })
      );

      // Image exists, return S3 URL
      const s3Url = `${process.env.NEXT_PUBLIC_CDN_URL}/${cacheKey}`;
      console.log(`Image already cached in S3: ${cacheKey}`);
      return s3Url;
    } catch (headError: any) {
      // Image doesn't exist, continue to download and upload
      if (headError.name !== 'NotFound') {
        throw headError;
      }
    }

    // Download the image with a per-attempt timeout and transient-error retry. The retry
    // policy lives in the shared `withRetry` helper - exponential backoff with jitter
    // and a wider transient set - instead of a hand-rolled loop. SSRF was already checked above
    // (the URL is immutable across attempts), so it correctly stays outside the retry.
    console.log(`Downloading external image from: ${url}`);
    let response: Response;
    try {
      const { result, attempts } = await withRetry<Response>(
        async () => {
          // Per-attempt 10s deadline - NOT a whole-operation cancel: each attempt gets a fresh
          // AbortController so a slow upstream is abandoned and retried rather than raced forever.
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 10000);
          const brand = process.env.APP_NAME || '';
          try {
            return await fetch(url, {
              headers: {
                'User-Agent': `Lumina5-ImageProxy/1.0${brand ? ` (${brand})` : ''}`,
                Accept: 'image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
              },
              signal: controller.signal,
            });
          } finally {
            clearTimeout(timeoutId);
          }
        },
        {
          maxRetries: 2, // initial attempt + 2 retries = 3 total, matching the prior loop
          initialDelayMs: 500,
          // Defer to the shared transient policy, but NEVER retry the per-attempt 10s timeout:
          // an AbortController abort surfaces as an AbortError whose message matches
          // isRetryableError's 'aborted'/'timeout' patterns - retrying it would just race a slow
          // upstream over and over (the behavior the original loop deliberately avoided).
          isRetryable: error => error.name !== 'AbortError' && isRetryableError(error),
          logger: {
            info: (msg, meta) => console.info(msg, meta),
            warn: (msg, meta) => console.warn(msg, meta),
          },
        }
      );
      response = result;
      if (attempts > 0) {
        console.info(`Fetch succeeded for ${url} after ${attempts} retr${attempts === 1 ? 'y' : 'ies'}`);
      }
    } catch (fetchError) {
      // Terminal failure (per-attempt timeout, or transient retries exhausted) - degrade
      // gracefully to the original URL, exactly as before.
      if (fetchError instanceof Error && fetchError.name === 'AbortError') {
        console.error(`Timeout fetching image from ${url} after 10s`);
      } else {
        console.error(`Failed to fetch image from ${url}:`, fetchError);
      }
      return url;
    }

    if (!response.ok) {
      console.error(`Failed to fetch image from ${url}: ${response.status} ${response.statusText}`);
      // Return original URL if download fails
      return url;
    }

    const contentType = response.headers.get('content-type') || 'image/jpeg';
    const buffer = await response.arrayBuffer();

    console.log(`Downloaded image: ${buffer.byteLength} bytes, uploading to S3...`);

    // Upload to S3 - bucket policy grants public read for proxied-images/* prefix
    await s3Client.send(
      new PutObjectCommand({
        Bucket: bucketName,
        Key: cacheKey,
        Body: Buffer.from(buffer),
        ContentType: contentType,
        CacheControl: 'public, max-age=31536000', // Cache for 1 year
      })
    );

    // Return S3 URL
    const s3Url = `https://${bucketName}.s3.${process.env.AWS_REGION || 'us-east-2'}.amazonaws.com/${cacheKey}`;
    console.log(`Image uploaded to S3: ${cacheKey}`);
    return s3Url;
  } catch (error) {
    console.error('Error caching external image:', error);
    // Return original URL if caching fails
    return url;
  }
}

/**
 * Cache multiple external image URLs to S3
 * @param images - Array of image objects with url property
 * @returns Array of image objects with S3 URLs
 */
export async function cacheExternalImages(
  images: Array<{ url: string; width?: number | null; height?: number | null }>
): Promise<Array<{ url: string; width?: number | null; height?: number | null }>> {
  return Promise.all(
    images.map(async image => ({
      ...image,
      url: await cacheExternalImage(image.url),
    }))
  );
}
