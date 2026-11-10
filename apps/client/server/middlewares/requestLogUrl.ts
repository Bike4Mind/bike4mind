// Import-free on purpose: proxy.ts imports this module too, so keep it dependency-light.

// A share-link token is a bearer read capability, so app log lines carry its path segment redacted.
// Every prefix that reaches the share-link branch of parsePublishPath: the viewer route (`/a/`), the
// `/p/a/` and `/uc/a/` rewrites (next.config.mjs) and the serve API itself.
const SHARE_TOKEN_PREFIXES = [['a'], ['p', 'a'], ['uc', 'a'], ['api', 'publish', 'serve', 'a']];

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment).toLowerCase();
  } catch {
    return segment.toLowerCase();
  }
}

// Segments are compared decoded (the serve route resolves from decoded query segments, so `%61` is
// served as `a`) and case-insensitively; over-redacting a non-share path is harmless.
export function redactShareTokenPath(url: string): string {
  const cut = url.search(/[?#]/);
  const path = cut === -1 ? url : url.slice(0, cut);
  const parts = path.split('/');
  const indexes = parts.flatMap((part, i) => (part ? [i] : []));
  const decoded = indexes.map(i => decodeSegment(parts[i]));
  for (const prefix of SHARE_TOKEN_PREFIXES) {
    if (decoded.length > prefix.length && prefix.every((segment, k) => decoded[k] === segment)) {
      parts[indexes[prefix.length]] = '[redacted]';
      return parts.join('/') + (cut === -1 ? '' : url.slice(cut));
    }
  }
  return url;
}

/** Log-safe form of a request URL: drops an identifier search's query and redacts a share-link token. */
export function requestLogUrl(url: string): string {
  const pathname = url.split('?')[0];
  return pathname === '/api/admin/search' ? pathname : redactShareTokenPath(url);
}
