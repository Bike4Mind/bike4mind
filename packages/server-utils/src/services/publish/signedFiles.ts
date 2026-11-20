import { GATE_TOKEN_TTL_SECONDS } from './publishGateToken';
import { PUBLISH_HOST } from './validateBundle';
import { isUsercontentHost } from './viewerSecurity';

/**
 * Publish - how bundle files reach the browser without going through the serve Lambda.
 *
 * The serve route answers with one buffered Lambda response, which caps a file at roughly
 * 4.5 MB, ignores Range (so a video cannot seek, and Safari will not play it at all), and
 * mangles any body whose Content-Type the edge adapter does not list as binary (see
 * `bufferedContentType`). So after the gate check, media and documents are handed out as
 * short-lived signed storage URLs instead: storage serves the bytes, with Range, from its
 * own origin, which is never the app origin or an artifact's usercontent origin.
 *
 * What a signed link may RENDER is decided here, from the file extension, never from the
 * publisher-supplied MIME type: the signed response pins `Content-Type` to the allowlisted
 * type, so a renamed `evil.html` shipped as `evil.pdf` arrives as a PDF, not as a page.
 * Anything off the allowlist is only ever signed as an `application/octet-stream`
 * attachment.
 */

/** Extension -> the only Content-Type a signed inline link to that file may carry. */
const INLINE_TYPES: Readonly<Record<string, string>> = {
  pdf: 'application/pdf',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
};

/**
 * Lifetime of a link handed out by redirect or `?sign=1`: the viewer opens it at once, so
 * it only has to outlive the navigation (and a PDF viewer's follow-up range requests).
 */
export const SIGNED_LINK_TTL_SECONDS = 15 * 60;

/**
 * Upper bound for a link baked into a rendered page (`<video src>`): it must outlive the
 * page, so a long video can still seek, but never the proof that authorized the render -
 * see `mediaLinkTtlSeconds`.
 */
export const SIGNED_MEDIA_TTL_SECONDS = GATE_TOKEN_TTL_SECONDS;

/** Floor so a proof about to expire still yields a link that survives the page load. */
const MIN_MEDIA_TTL_SECONDS = 60;

/**
 * TTL for a media link in a render authorized by a passphrase proof with `proofSecondsLeft`
 * remaining (null when another gate authorized it). Issued links are NOT revoked by a
 * takedown, a passphrase change, a revoked share link or a removed org member; this bound
 * is what limits them. Other gates have no proof lifetime to follow, so they get the
 * short file-link TTL: long media can stop seeking after that, and a reload mints fresh links.
 */
export function mediaLinkTtlSeconds(proofSecondsLeft: number | null): number {
  if (proofSecondsLeft === null) return SIGNED_LINK_TTL_SECONDS;
  return Math.max(MIN_MEDIA_TTL_SECONDS, Math.min(SIGNED_MEDIA_TTL_SECONDS, proofSecondsLeft));
}

/**
 * Largest file the buffered path is asked to send; anything bigger goes by signed link
 * whatever the request, since the buffered response caps out at roughly 4.5 MB.
 */
export const BUFFERED_FILE_MAX_BYTES = 4 * 1024 * 1024;

/**
 * Sec-Fetch-Dest values whose loader follows a cross-origin redirect: media, frames, navigations.
 * Not `track`: a caption file under a media element without `crossorigin` is fetched in
 * same-origin mode, so a redirect to storage is a network error and the captions vanish.
 */
const REDIRECTED_FETCH_DESTS = new Set(['video', 'audio', 'document', 'iframe', 'frame', 'embed', 'object']);

/** True when a request with this `Sec-Fetch-Dest` may be answered by a redirect to signed storage. */
export function isRedirectedFetchDest(dest: string | string[] | undefined): boolean {
  return typeof dest === 'string' && REDIRECTED_FETCH_DESTS.has(dest);
}

function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
}

/** The pinned Content-Type for viewing `path` inline from a signed link, or null if it may not be. */
export function inlineTypeFor(path: string): string | null {
  return INLINE_TYPES[extensionOf(path)] ?? null;
}

/**
 * True for files that are always delivered by signed link (video, audio, PDF): too large or
 * too Range-dependent for a buffered response, and never useful inlined as `data:`.
 */
export function isStreamedFile(path: string): boolean {
  const type = inlineTypeFor(path);
  return !!type && !type.startsWith('image/');
}

/**
 * True when signed links on `origin` are safe to hand out: http(s), and not a host whose
 * cookies or scripts this app owns - the app host, the request's own origin, or any
 * artifact usercontent host. A misconfigured browser-signing endpoint pointing at one of
 * those would let a pinned-type link render on an app-controlled origin, so the caller
 * falls back to the buffered path instead.
 */
export function isSafeSignedOrigin(origin: string, docOrigin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  if (url.origin === docOrigin) return false;
  const host = url.hostname.toLowerCase();
  if (PUBLISH_HOST && host === PUBLISH_HOST) return false;
  return !isUsercontentHost(host);
}

/** A `Content-Disposition` value for a signed link, with an ASCII-safe filename. */
export function signedDisposition(kind: 'inline' | 'attachment', path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1) || 'download';
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** The signing parameters for a bundle file: inline with its pinned type, or an opaque attachment. */
export function signedResponseFor(
  path: string,
  wantsDownload: boolean
): { ResponseContentType: string; ResponseContentDisposition: string } {
  const inline = wantsDownload ? null : inlineTypeFor(path);
  return inline
    ? { ResponseContentType: inline, ResponseContentDisposition: signedDisposition('inline', path) }
    : {
        ResponseContentType: 'application/octet-stream',
        ResponseContentDisposition: signedDisposition('attachment', path),
      };
}

/**
 * Binary Content-Types the edge adapter passes through untouched. MUST STAY IN SYNC with
 * `commonBinaryMimeTypes` in OpenNext's `utils/binary.ts` at the `openNextVersion` pinned in
 * infra/web.ts. A buffered response with any other type is converted as UTF-8 text on the
 * way out, splicing U+FFFD into the bytes. Notably absent upstream: `video/mp4`,
 * `audio/mp4`, `image/avif`, `application/wasm`, `audio/wav` and `audio/webm` (the last two
 * are fused into one entry by a missing comma there). So a wasm module goes out as
 * octet-stream and cannot use `WebAssembly.instantiateStreaming`; the publish docs tell
 * authors to instantiate from bytes. Corrupting it would be the only alternative.
 */
const EDGE_BINARY_TYPES = new Set([
  'application/octet-stream',
  'application/epub+zip',
  'application/msword',
  'application/pdf',
  'application/rtf',
  'application/vnd.amazon.ebook',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'font/otf',
  'font/woff',
  'font/woff2',
  'image/bmp',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/tiff',
  'image/vnd.microsoft.icon',
  'image/webp',
  'audio/3gpp',
  'audio/aac',
  'audio/basic',
  'audio/flac',
  'audio/mpeg',
  'audio/ogg',
  'audio/x-aiff',
  'audio/x-midi',
  'audio/x-wav',
  'video/3gpp',
  'video/mp2t',
  'video/mpeg',
  'video/ogg',
  'video/quicktime',
  'video/webm',
  'video/x-msvideo',
  'application/java-archive',
  'application/vnd.apple.installer+xml',
  'application/x-7z-compressed',
  'application/x-apple-diskimage',
  'application/x-bzip',
  'application/x-bzip2',
  'application/x-gzip',
  'application/x-java-archive',
  'application/x-rar-compressed',
  'application/x-tar',
  'application/x-zip',
  'application/zip',
  'application/x-protobuf',
]);

const TEXT_TYPES = /^(text\/|application\/(json|javascript|xml|manifest\+json)$|image\/svg\+xml$)/;

/**
 * The Content-Type to send a file with on the BUFFERED path. Text survives the adapter's
 * text conversion and binary types on its list pass through; any other declared type would
 * be corrupted, so it goes out as `application/octet-stream` instead - every buffered file is
 * an attachment or a subresource, and a byte-exact octet-stream beats a mangled exact type.
 */
export function bufferedContentType(declared: string): string {
  const type = declared.split(';')[0].trim().toLowerCase();
  if (TEXT_TYPES.test(type) || EDGE_BINARY_TYPES.has(type)) return declared;
  return 'application/octet-stream';
}
