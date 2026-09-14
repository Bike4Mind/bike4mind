import { afterEach, describe, expect, it, vi } from 'vitest';
import { CORE_DISALLOWED_PATHS } from './seo/crawlPolicy';

// WEBSITE_URL is read at module scope, so each case re-imports against its own mock.
async function loadRobots(websiteUrl: string, overlays: unknown[] = []) {
  vi.resetModules();
  vi.doMock('@client/config/general', () => ({ WEBSITE_URL: websiteUrl }));
  vi.doMock('./premium-generated/premiumRouteIndexing.generated', () => ({
    premiumRouteIndexing: overlays,
  }));
  return (await import('./robots')).default();
}

afterEach(() => vi.doUnmock('@client/config/general'));

describe('robots.txt', () => {
  it('allows the site and disallows every core private surface', async () => {
    const result = await loadRobots('https://example.test');
    const rule = Array.isArray(result.rules) ? result.rules[0] : result.rules;

    expect(rule?.userAgent).toBe('*');
    expect(rule?.allow).toBe('/');
    for (const path of CORE_DISALLOWED_PATHS) expect(rule?.disallow).toContain(path);
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
});
