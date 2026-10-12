import { readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { isDynamicRoute } from 'next/dist/shared/lib/router/utils/is-dynamic';
import { getRouteMatcher } from 'next/dist/shared/lib/router/utils/route-matcher';
import { getRouteRegex } from 'next/dist/shared/lib/router/utils/route-regex';
import { getSortedRoutes } from 'next/dist/shared/lib/router/utils/sorted-routes';

// Lives outside pages/: Next traces files under pages/ as routes, and a filesystem walk there
// drags the whole project into the server bundle (see the no-restricted-syntax rule).
const CATCH_ALL = '/api/[...unmatchedApiPath]';
const V1_CATCH_ALL = '/api/v1/[...unmatchedV1Path]';
const SPA_CATCH_ALL = '/[[...slug]]';

function collectApiRoutes(dir: string, prefix: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    if (entry.isDirectory()) {
      return entry.name === '__tests__' ? [] : collectApiRoutes(path.join(dir, entry.name), `${prefix}/${entry.name}`);
    }
    if (!/\.(ts|tsx|js|jsx)$/.test(entry.name) || /\.(test|spec)\./.test(entry.name)) return [];
    const name = entry.name.replace(/\.(ts|tsx|js|jsx)$/, '');
    return [name === 'index' ? prefix : `${prefix}/${name}`];
  });
}

const apiRoutes = collectApiRoutes(path.resolve(__dirname, '../../pages/api'), '/api');
const staticRoutes = new Set(apiRoutes.filter(r => !isDynamicRoute(r)));
// Next.js tries static routes first, then dynamic routes most-specific first; the app router's
// SPA optional catch-all (app/[[...slug]]) is ranked in the same list as the pages routes.
const dynamicMatchers = getSortedRoutes([...apiRoutes.filter(r => isDynamicRoute(r)), SPA_CATCH_ALL]).map(route => ({
  route,
  match: getRouteMatcher(getRouteRegex(route)),
}));

function resolve(pathname: string): string | undefined {
  if (staticRoutes.has(pathname)) return pathname;
  return dynamicMatchers.find(({ match }) => match(pathname))?.route;
}

function samplePath(route: string): string {
  return route
    .replace(/\[\[\.\.\.[^\]]+\]\]/g, 'x')
    .replace(/\[\.\.\.[^\]]+\]/g, 'x/y')
    .replace(/\[[^\]]+\]/g, 'x');
}

describe('pages/api/[...unmatchedApiPath] route precedence', () => {
  it('never outranks a real API route: every route file still serves its own path', () => {
    expect(apiRoutes).toContain(CATCH_ALL);
    const misrouted = apiRoutes
      .filter(r => r !== CATCH_ALL && resolve(samplePath(r)) !== r)
      .map(r => `${r} -> ${resolve(samplePath(r))}`);
    expect(misrouted).toEqual([]);
  });

  it.each([
    ['/api/does-not-exist', CATCH_ALL],
    ['/api/does-not-exist/at/all', CATCH_ALL],
    ['/api/stripe/webhook/extra', CATCH_ALL],
    // Two-segment misses were never SPA-served: the invite route [type]/[id] answers them.
    ['/api/does-not-exist/at-all', '/api/[type]/[id]'],
    ['/api/v1/nope', V1_CATCH_ALL],
    ['/api/v1/nope/at/all', V1_CATCH_ALL],
    // A miss below a real v1 folder is still a v1 miss, not the invite route or the root catch-all.
    ['/api/v1/files/does/not/exist', V1_CATCH_ALL],
    ['/api/stripe/webhook', '/api/stripe/webhook'],
    ['/api/publish/serve/a/b', '/api/publish/serve/[...path]'],
    ['/chat', SPA_CATCH_ALL],
    ['/', SPA_CATCH_ALL],
  ])('routes %s to %s', (pathname, expected) => {
    expect(resolve(pathname)).toBe(expected);
  });
});
