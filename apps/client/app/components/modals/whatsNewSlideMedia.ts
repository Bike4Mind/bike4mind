import { RELEASE_NOTE_MEDIA_PATH, type ModalStillImage, type ModalVideo } from '@bike4mind/common';

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

export interface SlideStillSource {
  src: string;
  orientation: SlideVideoOrientation;
}

/** Same orientation preference and fallback as pickSlideVideo. */
export function pickSlideStill(image: ModalStillImage | null | undefined, isMobile: boolean): SlideStillSource | null {
  if (!image) return null;
  const landscape: SlideStillSource | null = image.landscapeUrl
    ? { src: image.landscapeUrl, orientation: 'landscape' }
    : null;
  const portrait: SlideStillSource | null = image.portraitUrl
    ? { src: image.portraitUrl, orientation: 'portrait' }
    : null;
  return isMobile ? (portrait ?? landscape) : (landscape ?? portrait);
}

export function stillUrlsOf(image: ModalStillImage | null | undefined): string[] {
  if (!image) return [];
  return [image.landscapeUrl, image.portraitUrl].filter((url): url is string => !!url);
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
export function localizeMediaRouteUrls<T extends { [K in keyof T]: string | null | undefined }>(
  media: T,
  upstreamOrigin: string,
  base = window.location.origin
): T {
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
  const out = { ...media };
  for (const key of Object.keys(media) as (keyof T)[]) out[key] = localize(media[key]) as T[keyof T];
  return out;
}

/** A media route URL that bypasses any cached redirect, so the retry gets a newly signed target. */
export function withRetryParam(url: string): string {
  return `${url}${url.includes('?') ? '&' : '?'}retry=1`;
}
