import { afterEach, describe, expect, it, vi } from 'vitest';

async function loadSitemap(websiteUrl: string, overlays: unknown[] = []) {
  vi.resetModules();
  vi.doMock('@client/config/general', () => ({ WEBSITE_URL: websiteUrl }));
  vi.doMock('./premium-generated/premiumRouteIndexing.generated', () => ({
    premiumRouteIndexing: overlays,
  }));
  return (await import('./sitemap')).default();
}

afterEach(() => vi.doUnmock('@client/config/general'));

describe('sitemap.xml', () => {
  it('is empty in a checkout with no overlay installed', async () => {
    expect(await loadSitemap('https://example.test')).toEqual([]);
  });

  it('emits absolute urls, with the origin trailing slash collapsed', async () => {
    const result = await loadSitemap('https://example.test/', [{ sitemapPaths: ['/b', '/a'], disallowPaths: [] }]);
    expect(result).toEqual([{ url: 'https://example.test/a' }, { url: 'https://example.test/b' }]);
  });

  // Relative entries are invalid in a sitemap, so an unset origin must yield nothing
  // rather than a file every crawler would reject.
  it('is empty when no origin is configured', async () => {
    expect(await loadSitemap('', [{ sitemapPaths: ['/a'], disallowPaths: [] }])).toEqual([]);
  });
});
