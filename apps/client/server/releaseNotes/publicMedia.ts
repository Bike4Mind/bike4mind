import {
  MODAL_MEDIA_PREFIX,
  RELEASE_NOTE_MEDIA_FIELDS,
  RELEASE_NOTE_MEDIA_PATH,
  toPublicReleaseNoteVideo,
  type ModalVideo,
  type ModalVideoField,
  type PublicReleaseNoteVideo,
  type ReleaseNoteMediaAsset,
} from '@bike4mind/common';

const MEDIA_ASSETS = Object.entries(RELEASE_NOTE_MEDIA_FIELDS) as [ReleaseNoteMediaAsset, ModalVideoField][];

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

/**
 * A note's video for the public feed. Uploaded files are private, so each becomes a URL to the media
 * route, which signs on request; a linked URL is passed through. Without APP_URL the route path is
 * emitted relative to the reader's own origin rather than exposing the private bucket URL.
 */
export function toPublicFeedVideo(noteId: string, video: ModalVideo, bucket: string): PublicReleaseNoteVideo {
  const origin = process.env.APP_URL?.trim().replace(/\/+$/, '') ?? '';
  const served: ModalVideo = { ...video };
  for (const [asset, field] of MEDIA_ASSETS) {
    const url = video[field];
    if (url && ownModalMediaKey(url, bucket)) {
      served[field] = `${origin}${RELEASE_NOTE_MEDIA_PATH}/${encodeURIComponent(noteId)}/${asset}`;
    }
  }
  return toPublicReleaseNoteVideo(served);
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
