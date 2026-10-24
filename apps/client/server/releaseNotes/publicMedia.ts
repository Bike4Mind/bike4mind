import {
  MODAL_MEDIA_PREFIX,
  RELEASE_NOTE_IMAGE_MEDIA_FIELDS,
  RELEASE_NOTE_MEDIA_FIELDS,
  RELEASE_NOTE_MEDIA_PATH,
  toPublicReleaseNoteImage,
  toPublicReleaseNoteVideo,
  type ModalStillImage,
  type ModalVideo,
  type PublicReleaseNoteImage,
  type PublicReleaseNoteVideo,
} from '@bike4mind/common';

const VIDEO_ASSETS = Object.entries(RELEASE_NOTE_MEDIA_FIELDS);
const IMAGE_ASSETS = Object.entries(RELEASE_NOTE_IMAGE_MEDIA_FIELDS);

/**
 * The storage key of an admin-uploaded modal file in the app's files bucket, or null for any other URL.
 * Uploads are stored as the bucket's virtual-hosted URL (getS3Url in app/utils/s3.ts).
 */
export function ownModalMediaKey(url: string, bucket: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  if (parsed.protocol !== 'https:' || !host.startsWith(`${bucket.toLowerCase()}.s3.`)) return null;
  if (!host.endsWith('.amazonaws.com')) return null;
  let key: string;
  try {
    key = decodeURIComponent(parsed.pathname.slice(1));
  } catch {
    return null;
  }
  return key.startsWith(`${MODAL_MEDIA_PREFIX}/`) ? key : null;
}

/** Points each own upload in `urls` at its media route; linked URLs pass through. */
function withMediaRoutes<T extends object>(noteId: string, urls: T, assets: [string, string][], bucket: string): T {
  const origin = process.env.APP_URL?.trim().replace(/\/+$/, '') ?? '';
  // Read each field through the source's own accessors: `urls` is a Mongoose subdocument on the feed route,
  // and a spread of one copies its internals, not its fields.
  const source = urls as Record<string, string | null | undefined>;
  const served: Record<string, string | null | undefined> = {};
  for (const [asset, field] of assets) {
    const url = source[field] ?? null;
    served[field] =
      url && ownModalMediaKey(url, bucket)
        ? `${origin}${RELEASE_NOTE_MEDIA_PATH}/${encodeURIComponent(noteId)}/${asset}`
        : url;
  }
  return served as unknown as T;
}

/**
 * A note's video for the public feed. Uploaded files are private, so each becomes a URL to the media
 * route, which signs on request; a linked URL is passed through. Without APP_URL the route path is
 * emitted relative to the reader's own origin rather than exposing the private bucket URL.
 */
export function toPublicFeedVideo(noteId: string, video: ModalVideo, bucket: string): PublicReleaseNoteVideo {
  return toPublicReleaseNoteVideo(withMediaRoutes(noteId, video, VIDEO_ASSETS, bucket));
}

/** A note's still image for the public feed, served through the media route like the video. */
export function toPublicFeedImage(noteId: string, image: ModalStillImage, bucket: string): PublicReleaseNoteImage {
  return toPublicReleaseNoteImage(withMediaRoutes(noteId, image, IMAGE_ASSETS, bucket));
}

/** Whether `url` is on the media route of the deployment that serves the feed at `feedUrl`. */
export function isUpstreamMediaUrl(url: string, feedUrl: string): boolean {
  try {
    const media = new URL(url);
    return (
      media.protocol === 'https:' &&
      media.origin === new URL(feedUrl).origin &&
      media.pathname.startsWith(`${RELEASE_NOTE_MEDIA_PATH}/`)
    );
  } catch {
    return false;
  }
}
