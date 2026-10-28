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
 * Cloudflare Turnstile loads its script and widget frame from this origin. The service worker must
 * never answer those requests: a worker fetch is checked against the CSP of the worker script, which
 * is the policy from whichever build installed it, and `defaultCache` would otherwise proxy every
 * cross-origin request through NetworkFirst. While a new worker is still precaching after a deploy,
 * the old worker's policy keeps serving sign-in, so the challenge script is refused and the sign-in
 * code or OAuth start fails. Letting the browser fetch natively keeps the document's own CSP in charge.
 */
export const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com';

export function bypassesServiceWorker(url: URL): boolean {
  return url.origin === TURNSTILE_ORIGIN;
}
