import { RELEASE_NOTE_MEDIA_PATH, type ModalVideo } from '@bike4mind/common';

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

const MEDIA_ROUTE_PATH = `${RELEASE_NOTE_MEDIA_PATH}/`;

export function isMediaRouteUrl(url: string, base = window.location.origin): boolean {
  try {
    return new URL(url, base).pathname.startsWith(MEDIA_ROUTE_PATH);
  } catch {
    return false;
  }
}

/**
 * The feed names this deployment's media route by APP_URL, which may be another of its domains than the
 * one being browsed, and the CSP only allows this origin. So a media route URL is made relative here,
 * except on the upstream feed's origin, which is genuinely another deployment.
 */
export function localizeMediaRouteUrls(
  video: ModalVideo,
  upstreamOrigin: string,
  base = window.location.origin
): ModalVideo {
  const localize = (url: string | null | undefined) => {
    if (!url) return url;
    try {
      const parsed = new URL(url);
      if (parsed.origin === upstreamOrigin || !isMediaRouteUrl(url, base)) return url;
      return `${parsed.pathname}${parsed.search}`;
    } catch {
      return url;
    }
  };
  return {
    landscapeUrl: localize(video.landscapeUrl),
    landscapePosterUrl: localize(video.landscapePosterUrl),
    portraitUrl: localize(video.portraitUrl),
    portraitPosterUrl: localize(video.portraitPosterUrl),
  };
}

/** A media route URL that bypasses any cached redirect, so the retry gets a newly signed target. */
export function withRetryParam(url: string): string {
  return `${url}${url.includes('?') ? '&' : '?'}retry=1`;
}
