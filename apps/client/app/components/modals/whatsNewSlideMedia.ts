import type { ModalVideo } from '@bike4mind/common';

export type SlideVideoOrientation = 'landscape' | 'portrait';

export interface SlideVideoSource {
  src: string;
  poster: string | null;
  orientation: SlideVideoOrientation;
}

/** Desktop prefers the 16:9 cut and mobile the 9:16 cut; each falls back to the other. */
export function pickSlideVideo(video: ModalVideo | null | undefined, isMobile: boolean): SlideVideoSource | null {
  if (!video) return null;
  const landscape: SlideVideoSource | null = video.landscapeUrl
    ? { src: video.landscapeUrl, poster: video.landscapePosterUrl ?? null, orientation: 'landscape' }
    : null;
  const portrait: SlideVideoSource | null = video.portraitUrl
    ? { src: video.portraitUrl, poster: video.portraitPosterUrl ?? null, orientation: 'portrait' }
    : null;
  return isMobile ? (portrait ?? landscape) : (landscape ?? portrait);
}

export function videoUrlsOf(video: ModalVideo | null | undefined): string[] {
  if (!video) return [];
  return [video.landscapeUrl, video.landscapePosterUrl, video.portraitUrl, video.portraitPosterUrl].filter(
    (url): url is string => !!url
  );
}

/**
 * S3 key of an uploaded file's URL (it needs presigning, the bucket is private), or null for any other
 * URL, which the browser loads as-is.
 */
export function storageKeyOf(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!parsed.hostname.endsWith('.amazonaws.com')) return null;
  const key = parsed.pathname.replace(/^\//, '');
  return key || null;
}
