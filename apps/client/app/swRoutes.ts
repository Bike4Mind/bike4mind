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
