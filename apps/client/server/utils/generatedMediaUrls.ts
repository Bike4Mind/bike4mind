import { getGeneratedImageStorage } from '@server/utils/storage';

// Clients cache these for less than this (useGeneratedMediaUrls staleTime), so a URL is never
// handed to a media element after it expires.
export const GENERATED_MEDIA_URL_TTL_SECONDS = 3600;

/**
 * Short-lived presigned GET URLs for generated-bucket keys. The caller must already have
 * authorized every key: signing is the read grant. `audience: 'browser'` makes self-host sign
 * against its browser-reachable endpoint (S3_PRESIGN_ENDPOINT).
 */
export async function signGeneratedMediaUrls(keys: string[]): Promise<Record<string, string>> {
  const storage = getGeneratedImageStorage();
  const entries = await Promise.all(
    [...new Set(keys)].map(
      async key =>
        [
          key,
          await storage.getSignedUrl(key, 'get', { expiresIn: GENERATED_MEDIA_URL_TTL_SECONDS, audience: 'browser' }),
        ] as const
    )
  );
  return Object.fromEntries(entries);
}
