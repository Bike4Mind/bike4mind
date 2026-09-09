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
 *     is stored XSS, so callers must opt into `inline` explicitly and only for
 *     bytes the server itself produced. There is no MIME-sniffing `auto` mode
 *     here: a helper that infers safety from a stored MIME type can't know
 *     whether it is being called for a response header (app origin) or a
 *     storage-signed URL override (storage origin), and the two have different
 *     threat models.
 *
 * Import from the lightweight subpath (`@bike4mind/utils/contentDisposition`),
 * not the package barrel - see the note on `escapeRegex`.
 */

/** Longest filename emitted into the header; longer names are truncated. */
const MAX_FILENAME_LENGTH = 150;

/** Longest suffix treated as a preservable extension when truncating. */
const MAX_EXTENSION_LENGTH = 20;

/**
 * Control characters are scrubbed BEFORE either parameter is built, not merely
 * escaped into `filename*`: a percent-encoded CRLF is header-safe but would still
 * be decoded back into the saved filename by the browser. U+0080-U+009F (C1
 * controls, e.g. NEL) are non-ASCII, so they'd otherwise pass through into the
 * percent-encoded `filename*` untouched even though `filename` scrubs them to `_`.
 */
function scrubControlChars(value: string): string {
  return Array.from(value, ch => {
    const code = ch.codePointAt(0)!;
    return code < 0x20 || (code >= 0x7f && code <= 0x9f) ? '_' : ch;
  }).join('');
}

/**
 * Truncate to `maxLength` Unicode code points (not UTF-16 units, which would
 * split a surrogate pair and make `encodeURIComponent` throw downstream),
 * reserving room for the extension so a long filename doesn't lose the suffix
 * that tells the OS which app to open it with.
 */
function truncatePreservingExtension(fileName: string, maxLength: number): string {
  const chars = Array.from(fileName);
  if (chars.length <= maxLength) return chars.join('');

  const dotIndex = chars.lastIndexOf('.');
  const extLength = dotIndex > 0 ? chars.length - dotIndex : 0;
  const ext = extLength > 0 && extLength <= MAX_EXTENSION_LENGTH ? chars.slice(dotIndex) : [];
  const stem = chars.slice(0, Math.max(maxLength - ext.length, 0));
  return stem.join('') + ext.join('');
}

const NON_ASCII = /[^\x20-\x7e]/;
const NON_ASCII_GLOBAL = /[^\x20-\x7e]/g;

/** Percent-encode for an RFC 5987 `filename*` value (the chars encodeURIComponent leaves alone). */
function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

export interface ContentDispositionOptions {
  /**
   * `attachment` (the default) always downloads. `inline` is unconditional and
   * should be used only for bytes the server itself produced.
   */
  disposition?: 'attachment' | 'inline';
}

/**
 * `Content-Disposition` for a download, safe to interpolate into a response
 * header or a storage `ResponseContentDisposition` override.
 */
export function buildContentDisposition(fileName: string, options: ContentDispositionOptions = {}): string {
  const { disposition = 'attachment' } = options;

  const safe = scrubControlChars(truncatePreservingExtension(fileName ?? '', MAX_FILENAME_LENGTH));
  const asciiName = safe.replace(NON_ASCII_GLOBAL, '_').replace(/["\\]/g, '_').trim() || 'download';
  const extended = NON_ASCII.test(safe) ? `; filename*=UTF-8''${encodeRfc5987(safe)}` : '';

  return `${disposition}; filename="${asciiName}"${extended}`;
}
