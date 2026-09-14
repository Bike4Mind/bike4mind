// @vitest-environment node
// A build-step metadata route; it only lives under app/ because Next requires it there.
import { afterEach, describe, expect, it, vi } from 'vitest';

async function loadSitemapModule(canonicalOrigin: string, overlays: unknown[] = []) {
  vi.resetModules();
  vi.doMock('@client/config/general', () => ({ CANONICAL_ORIGIN: canonicalOrigin }));
  vi.doMock('./premium-generated/premiumRouteIndexing.generated', () => ({
    premiumRouteIndexing: overlays,
  }));
  return import('./sitemap');
}

async function loadSitemap(canonicalOrigin: string, overlays: unknown[] = []) {
  return (await loadSitemapModule(canonicalOrigin, overlays)).default();
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

  // The sitemap and robots.txt are built from independent contribution fields, so this
  // is the assertion that keeps the two files from contradicting each other.
  it('never advertises a url that robots.txt forbids', async () => {
    const result = await loadSitemap('https://example.test', [
      { sitemapPaths: ['/widgets/overview', '/kept'], disallowPaths: ['/widgets/'] },
    ]);
    expect(result).toEqual([{ url: 'https://example.test/kept' }]);
  });

  it('is statically generated', async () => {
    expect((await loadSitemapModule('https://example.test')).dynamic).toBe('force-static');
  });
});
