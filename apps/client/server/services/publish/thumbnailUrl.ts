import { getPublishedArtifactsStorage } from '@bike4mind/server-utils/utils/storage/index';
import { isPublishThumbnailKeyFor } from '@bike4mind/server-utils/utils/publishThumbnails';

/**
 * Thumbnail links are signed as of the start of a fixed window, so every listing within one window
 * hands out the identical URL and the browser serves the image from cache instead of re-fetching it
 * on each refetch. Identical only for the same signing credentials: separate web Lambda instances
 * sign with their own session credentials, so caching across them is best-effort.
 */
export const THUMBNAIL_URL_WINDOW_SECONDS = 15 * 60;
/** Lifetime from the window start (s): a link always has at least one full window left when handed out. */
export const THUMBNAIL_URL_TTL_SECONDS = 2 * THUMBNAIL_URL_WINDOW_SECONDS;

/** Start of the signing window containing `now`. */
export function thumbnailSigningDate(now: Date = new Date()): Date {
  const windowMs = THUMBNAIL_URL_WINDOW_SECONDS * 1000;
  return new Date(Math.floor(now.getTime() / windowMs) * windowMs);
}

/**
 * Short-lived browser link to an artifact's owner-only thumbnail. The CALLER must have established
 * that the requester owns the artifact: this is the only way a thumbnail leaves the private bucket,
 * and no serve, share or meta surface may call it. Undefined when the stored key does not belong to
 * the artifact or signing fails - a listing degrades to the generated cover, never to an error.
 */
export async function signOwnerThumbnailUrl(publicId: string, key: string): Promise<string | undefined> {
  if (!isPublishThumbnailKeyFor(publicId, key)) return undefined;
  try {
    return await getPublishedArtifactsStorage().getSignedUrl(key, 'get', {
      expiresIn: THUMBNAIL_URL_TTL_SECONDS,
      audience: 'browser',
      ResponseContentType: 'image/webp',
      signingDate: thumbnailSigningDate(),
    });
  } catch {
    return undefined;
  }
}
