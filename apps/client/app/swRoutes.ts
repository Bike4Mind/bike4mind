/**
 * Same-origin Next.js API routes (`/api/*`) must never be served from the service-worker
 * cache. Serwist's `defaultCache` has broad `.js`/catch-all matchers that otherwise
 * cache HTML API routes like `/api/react-artifact-sandbox`, so after a deploy a returning user
 * runs the stale shell for at least one load. API routes are dynamic and per-request - caching
 * their responses in the SW is wrong in principle.
 *
 * Kept as a tiny pure predicate (not inlined in `sw.ts`) so it is unit-testable: `sw.ts`
 * instantiates `Serwist` and references `self` at module load and can't be imported in a test.
 */
export function isApiPath(pathname: string): boolean {
  // Exact `/api` or anything under `/api/` - anchored so `/apiary`, `/api-docs`, `/foo/api/bar`
  // do NOT match.
  return pathname === '/api' || pathname.startsWith('/api/');
}

/** The only cross-origin hosts the service worker caches; every other cross-origin request bypasses it. */
export const CACHED_CROSS_ORIGIN_HOSTS: ReadonlySet<string> = new Set(['fonts.googleapis.com', 'fonts.gstatic.com']);

/**
 * True when the service worker must leave `request` to the browser: no `respondWith`, so the page's
 * own CSP and fetch semantics apply instead of the worker's.
 *
 * A fetch the worker makes is checked against the CSP of the `/serwist/sw.js` response it was
 * installed from, not the page's. A worker installed before a CSP change keeps the old policy until
 * it updates, so routing third-party loads through it (Serwist's `defaultCache` ends in a catch-all
 * `!sameOrigin` NetworkFirst route) blocks hosts the page itself allows - sign-in broke when such a
 * worker refused the Turnstile script. That route bought only an hour-long fallback cache (and for
 * Turnstile, a stale `api.js` after a 10s timeout), so only Google Fonts is still cached.
 *
 * Worker entrypoints are bypassed for a different reason, see the fetch listener in `sw.ts`.
 */
export function bypassesServiceWorker(request: Pick<Request, 'url' | 'destination'>, origin: string): boolean {
  if (request.destination === 'worker' || request.destination === 'sharedworker') return true;
  if (request.url.startsWith(`${origin}/`)) return false;
  return !CACHED_CROSS_ORIGIN_HOSTS.has(new URL(request.url).hostname);
}
