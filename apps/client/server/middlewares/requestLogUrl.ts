// Import-free on purpose: proxy.ts runs in the edge runtime and imports this module too.

// A share-link token is a bearer read capability, so its path segment never reaches app logs.
// Covers the viewer route (`/a/<token>`) and its API (`/api/publish/serve/a/<token>/...`).
const SHARE_TOKEN_PATH = /^(\/+(?:api\/+publish\/+serve\/+)?a\/+)([^/?#]+)/;

export function redactShareTokenPath(url: string): string {
  return url.replace(SHARE_TOKEN_PATH, '$1[redacted]');
}

/** Log-safe form of a request URL: drops an identifier search's query and redacts a share-link token. */
export function requestLogUrl(url: string): string {
  const pathname = url.split('?')[0];
  return pathname === '/api/admin/search' ? pathname : redactShareTokenPath(url);
}
