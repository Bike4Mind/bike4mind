import { getPublishedArtifactsStorage } from '@bike4mind/server-utils/utils/storage/index';
import { isPublishThumbnailKeyFor } from '@bike4mind/server-utils/utils/publishThumbnails';

/** Lifetime of a thumbnail link on the owner's management listing, in seconds. */
export const THUMBNAIL_URL_TTL_SECONDS = 15 * 60;

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
    });
  } catch {
    return undefined;
  }
}
