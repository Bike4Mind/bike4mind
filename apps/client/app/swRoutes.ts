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

/**
 * Published artifact pages (`/p/*`, `/a/*`) may be gated to an org or to one user. The worker sees
 * the path before next.config rewrites it to `/api/publish/serve`, so `isApiPath` does not cover it.
 */
export function isPublishedArtifactPath(pathname: string): boolean {
  return pathname.startsWith('/p/') || pathname.startsWith('/a/');
}

const FONT_HOSTS = new Set(['fonts.googleapis.com', 'fonts.gstatic.com']);

/**
 * Responses the service worker must never write to Cache Storage, because they can carry one
 * account's private content: API routes, published artifact pages, and cross-origin requests
 * (presigned media URLs) other than fonts. Cache Storage outlives sign-out.
 */
export function isNeverCached(url: URL, sameOrigin: boolean): boolean {
  if (sameOrigin) return isApiPath(url.pathname) || isPublishedArtifactPath(url.pathname);
  return !FONT_HOSTS.has(url.hostname);
}

/** The service worker's precache holds only build assets; every other cache may hold per-user responses. */
export function isPrecacheName(cacheName: string): boolean {
  return cacheName.includes('precache');
}

/**
 * Cloudflare Turnstile loads its script and widget frame from this origin. They must always come live
 * from Cloudflare, so the service worker never answers them: `defaultCache` would otherwise proxy every
 * cross-origin request through NetworkFirst (a cached `api.js` fallback after a 10s timeout), and a
 * worker fetch is checked against the worker script's own CSP rather than the document's. Letting the
 * browser fetch natively keeps the document's CSP authoritative. Prompted by sign-in failures from
 * workers installed before this origin was added to the CSP.
 */
export const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com';

export function bypassesServiceWorker(url: URL): boolean {
  return url.origin === TURNSTILE_ORIGIN;
}
