import { resolveAndVetUrl } from './ssrfGuard';

/**
 * SSRF-guarded fetch for direct server-side requests against a user/model-supplied origin.
 *
 * Vets the URL through `resolveAndVetUrl` before any outbound request, refuses non-https/private/
 * loopback/link-local/metadata targets, and uses `redirect: 'error'` so a public origin cannot
 * 302-pivot to an internal address after the check. For http it pins the vetted IP (connecting to
 * the resolved address with the original Host header) so fetch cannot re-resolve to a rebind target;
 * for https it keeps the hostname because TLS certificate validation already defeats rebind and
 * pinning would break SNI. Same convention as `plainFetchScrape` (see plainFetch.ts:78-99).
 *
 * Passes `method`/`headers`/`body` through unchanged (the http pin only adds a Host header). Returns
 * the raw Response so the caller handles status/body as it sees fit.
 */
export async function guardedFetch(url: string, init: RequestInit = {}): Promise<Response> {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    throw new Error(`Refusing to fetch ${url}: invalid URL`);
  }

  const vetted = await resolveAndVetUrl(target);
  if (!vetted.safe) {
    throw new Error(`Refusing to fetch ${url}: ${vetted.reason}`);
  }

  let fetchUrl = url;
  const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined) };
  if (target.protocol === 'http:') {
    headers.Host = target.host;
    const pinned = new URL(target.toString());
    pinned.hostname = vetted.family === 6 ? `[${vetted.address}]` : vetted.address;
    fetchUrl = pinned.toString();
  }

  return fetch(fetchUrl, { ...init, headers, redirect: 'error' });
}
