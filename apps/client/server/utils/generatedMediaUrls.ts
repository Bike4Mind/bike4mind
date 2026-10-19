import { getGeneratedImageStorage } from '@server/utils/storage';

// Clients re-sign well before this (useGeneratedMediaUrls), so a URL is never handed to a media
// element after it expires.
export const GENERATED_MEDIA_URL_TTL_SECONDS = 3600;

/**
 * Self-host signs against AWS_ENDPOINT_URL_S3 (e.g. http://minio:9000) unless S3_PRESIGN_ENDPOINT
 * names a browser-reachable origin, and that endpoint is optional. Without it a presigned URL is
 * unreachable from the browser, so keep serving through the same-origin app-files proxy
 * (NEXT_PUBLIC_CDN_URL=/api/app-files/serve, see appFileProxy.ts).
 */
const proxyBaseWhenUnsignable = (): string | undefined => {
  const privateEndpoint = process.env.AWS_ENDPOINT_URL_S3?.trim();
  const browserEndpoint = process.env.S3_PRESIGN_ENDPOINT?.trim();
  if (!privateEndpoint || browserEndpoint) return undefined;
  const cdnUrl = (process.env.NEXT_PUBLIC_CDN_URL || '').replace(/\/+$/, '');
  return cdnUrl ? `${cdnUrl}/generated` : undefined;
};

/**
 * Short-lived presigned GET URLs for generated-bucket keys. The caller must already have
 * authorized every key: signing is the read grant. `audience: 'browser'` makes self-host sign
 * against its browser-reachable endpoint (S3_PRESIGN_ENDPOINT).
 */
export async function signGeneratedMediaUrls(keys: string[]): Promise<Record<string, string>> {
  const uniqueKeys = [...new Set(keys)];
  const proxyBase = proxyBaseWhenUnsignable();
  if (proxyBase) {
    return Object.fromEntries(uniqueKeys.map(key => [key, `${proxyBase}/${encodeURIComponent(key)}`]));
  }
  const storage = getGeneratedImageStorage();
  const entries = await Promise.all(
    uniqueKeys.map(
      async key =>
        [
          key,
          await storage.getSignedUrl(key, 'get', { expiresIn: GENERATED_MEDIA_URL_TTL_SECONDS, audience: 'browser' }),
        ] as const
    )
  );
  return Object.fromEntries(entries);
}
