// @vitest-environment node
// A build-step metadata route; it only lives under app/ because Next requires it there.
import { afterEach, describe, expect, it, vi } from 'vitest';

// CANONICAL_ORIGIN is read at module scope, so each case re-imports against its own mock.
async function loadRobotsModule(canonicalOrigin: string, overlays: unknown[] = []) {
  vi.resetModules();
  vi.doMock('@client/config/general', () => ({ CANONICAL_ORIGIN: canonicalOrigin }));
  vi.doMock('./premium-generated/premiumRouteIndexing.generated', () => ({
    premiumRouteIndexing: overlays,
  }));
  return import('./robots');
}

async function loadRobots(canonicalOrigin: string, overlays: unknown[] = []) {
  return (await loadRobotsModule(canonicalOrigin, overlays)).default();
}

afterEach(() => vi.doUnmock('@client/config/general'));

describe('robots.txt', () => {
  it('allows the site and disallows the core private surfaces', async () => {
    const result = await loadRobots('https://example.test');
    const rule = Array.isArray(result.rules) ? result.rules[0] : result.rules;

    expect(rule?.userAgent).toBe('*');
    expect(rule?.allow).toBe('/');
    // Literals, not a re-read of the constant the file under test already imports.
    for (const path of ['/api/', '/login', '/admin', '/notebooks', '/organizations', '/profile']) {
      expect(rule?.disallow).toContain(path);
    }
  });

  // The URL is the credential on these, and they already carry a per-response
  // `X-Robots-Tag: noindex`. Blocking the fetch would hide that header from the crawler
  // while leaving the URL indexable from any link to it.
  it('leaves the capability-token share surfaces crawlable', async () => {
    const result = await loadRobots('https://example.test');
    const rule = Array.isArray(result.rules) ? result.rules[0] : result.rules;
    const disallow = (rule?.disallow ?? []) as string[];

    // Prefix-of-URL matching, the direction robots.txt actually uses.
    for (const url of ['/p/abc', '/a/shareToken', '/a/shareToken/asset.png', '/uc/abc', '/embed/abc']) {
      expect(disallow.filter(pattern => url.startsWith(pattern))).toEqual([]);
    }
  });

  // Emitting a `Sitemap:` line pointing at an empty urlset is worse than omitting it,
  // and with no configured origin it could not be written absolutely anyway.
  it('omits the sitemap line when there is nothing to list', async () => {
    expect(await loadRobots('https://example.test')).not.toHaveProperty('sitemap');
  });

  it('omits the sitemap line when no origin is configured', async () => {
    const result = await loadRobots('', [{ sitemapPaths: ['/x'], disallowPaths: [] }]);
    expect(result).not.toHaveProperty('sitemap');
  });

  it('points at an absolute sitemap url once an overlay contributes a path', async () => {
    const result = await loadRobots('https://example.test/', [{ sitemapPaths: ['/x'], disallowPaths: [] }]);
    expect(result.sitemap).toBe('https://example.test/sitemap.xml');
  });

  // The single line that makes this a build-time file rather than per-request Lambda
  // work. Dropping it in a refactor would give a green build and green tests, with no
  // signal short of a latency graph.
  it('is statically generated', async () => {
    expect((await loadRobotsModule('https://example.test')).dynamic).toBe('force-static');
  });
});
