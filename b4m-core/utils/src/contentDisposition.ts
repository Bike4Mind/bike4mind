/**
 * Build a `Content-Disposition` header value from a user-controlled filename.
 *
 * Every download endpoint needs the same three properties, and each one that
 * hand-rolls the header has historically got at least one of them wrong:
 *
 *  1. **Header safety.** A filename is user-controlled (upload names, curated
 *     notebook names, exported channel names). Interpolating it raw into
 *     `filename="..."` lets a `"` or a backslash terminate the quoted-string and
 *     append attacker-chosen header parameters. Sanitized here, once.
 *  2. **Non-ASCII names survive.** RFC 6266 says a name outside the header's
 *     ASCII charset travels in an RFC 5987 `filename*` parameter alongside the
 *     ASCII `filename` fallback. Percent-encoding the plain `filename` instead
 *     is a common miss: browsers save the literal `my%20file.pdf`.
 *  3. **`inline` is an XSS decision, not a convenience.** Serving
 *     attacker-supplied `image/svg+xml` or `text/html` inline on the app origin
 *     is stored XSS. `auto` therefore inlines only render-safe types and forces
 *     `attachment` for everything else, rather than trusting the stored MIME.
 *
 * Import from the lightweight subpath (`@bike4mind/utils/contentDisposition`),
 * not the package barrel - see the note on `escapeRegex`.
 */

/**
 * Non-image types `auto` may serve inline. PDF is included because the viewer
 * reads the bytes and the signed URL lives on the storage origin, not the app
 * origin, so a direct inline open is already sandboxed away from app scripts.
 * `image/svg+xml` is excluded by the image rule below and must stay excluded:
 * SVG is a script-bearing document format.
 */
export const INLINE_SAFE_MIME_TYPES: ReadonlySet<string> = new Set([
  'application/pdf',
  'application/json',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
  'text/markdown',
  'text/csv',
]);

/** Longest filename emitted into the header; longer names are truncated. */
const MAX_FILENAME_LENGTH = 150;

/**
 * Control characters are scrubbed BEFORE either parameter is built, not merely
 * escaped into `filename*`: a percent-encoded CRLF is header-safe but would still
 * be decoded back into the saved filename by the browser.
 */
function scrubControlChars(value: string): string {
  return Array.from(value, ch => {
    const code = ch.codePointAt(0)!;
    return code < 0x20 || code === 0x7f ? '_' : ch;
  }).join('');
}

const NON_ASCII = /[^\x20-\x7e]/;
const NON_ASCII_GLOBAL = /[^\x20-\x7e]/g;

/** Percent-encode for an RFC 5987 `filename*` value (the chars encodeURIComponent leaves alone). */
function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** True when `auto` may serve this MIME type inline. */
export function isInlineSafeMimeType(mimeType: string | null | undefined): boolean {
  const mime = (mimeType ?? '').split(';')[0].trim().toLowerCase();
  if (mime.startsWith('image/')) return mime !== 'image/svg+xml';
  return INLINE_SAFE_MIME_TYPES.has(mime);
}

export interface ContentDispositionOptions {
  /**
   * `attachment` (the default) always downloads. `auto` inlines only when
   * `mimeType` is render-safe. `inline` is unconditional and should be used only
   * for bytes the server itself produced.
   */
  disposition?: 'attachment' | 'inline' | 'auto';
  /** Required by `auto`; ignored otherwise. */
  mimeType?: string | null;
}

/**
 * `Content-Disposition` for a download, safe to interpolate into a response
 * header or a storage `ResponseContentDisposition` override.
 */
export function buildContentDisposition(fileName: string, options: ContentDispositionOptions = {}): string {
  const { disposition = 'attachment', mimeType } = options;
  const type = disposition === 'auto' ? (isInlineSafeMimeType(mimeType) ? 'inline' : 'attachment') : disposition;

  const safe = scrubControlChars((fileName ?? '').slice(0, MAX_FILENAME_LENGTH));
  const asciiName = safe.replace(NON_ASCII_GLOBAL, '_').replace(/["\\]/g, '_').trim() || 'download';
  const extended = NON_ASCII.test(safe) ? `; filename*=UTF-8''${encodeRfc5987(safe)}` : '';

  return `${type}; filename="${asciiName}"${extended}`;
}
