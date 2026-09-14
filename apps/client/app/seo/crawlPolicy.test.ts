import { describe, expect, it } from 'vitest';
import type { PremiumRouteIndexing } from '../premiumContract';
import {
  CORE_DISALLOWED_PATHS,
  buildDisallowList,
  buildSitemapPaths,
  buildSitemapUrl,
  normalizeOrigin,
} from './crawlPolicy';

const overlay = (o: Partial<PremiumRouteIndexing>): PremiumRouteIndexing => ({
  sitemapPaths: [],
  disallowPaths: [],
  ...o,
});

describe('buildDisallowList', () => {
  it('covers every core surface with no overlay installed (the fork build)', () => {
    expect(buildDisallowList([])).toEqual([...CORE_DISALLOWED_PATHS].sort());
  });

  it('merges overlay patterns in', () => {
    const result = buildDisallowList([overlay({ disallowPaths: ['/widgets'] })]);
    expect(result).toContain('/widgets');
    for (const path of CORE_DISALLOWED_PATHS) expect(result).toContain(path);
  });

  // A published artifact is indexable only when its owner opts in, and that is enforced
  // per response by the serve handler. Disallowing the prefix would stop the crawler
  // fetching the page at all, so it would never see the `index` header.
  it('never disallows the owner-opt-in published-artifact prefix', () => {
    expect(buildDisallowList([overlay({ disallowPaths: ['/widgets'] })]).some(p => p.startsWith('/p/'))).toBe(false);
  });

  it('is deduped and stable regardless of overlay order', () => {
    const a = overlay({ disallowPaths: ['/b', '/api/'] });
    const b = overlay({ disallowPaths: ['/a', '/b'] });
    expect(buildDisallowList([a, b])).toEqual(buildDisallowList([b, a]));
    expect(buildDisallowList([a, b]).filter(p => p === '/b')).toHaveLength(1);
  });

  // Overlay data is typed only at the contribution boundary, so a bad value would
  // otherwise land verbatim in a served file. A protocol-relative path is the sharp
  // case: `//evil.test` reads as a host to a crawler, not as a path on this origin.
  it('drops entries that are not origin-relative paths', () => {
    const result = buildDisallowList([
      overlay({ disallowPaths: ['//evil.test', 'no-leading-slash', 'https://evil.test/x', '/kept'] }),
    ]);
    expect(result).toContain('/kept');
    expect(result).not.toContain('//evil.test');
    expect(result).not.toContain('no-leading-slash');
    expect(result).not.toContain('https://evil.test/x');
  });

  it('tolerates an overlay that omits the arrays entirely', () => {
    const malformed = { sitemapPaths: undefined, disallowPaths: undefined } as unknown as PremiumRouteIndexing;
    expect(() => buildDisallowList([malformed])).not.toThrow();
    expect(buildDisallowList([malformed])).toEqual([...CORE_DISALLOWED_PATHS].sort());
  });
});

describe('buildSitemapPaths', () => {
  it('is empty with no overlay installed - core has no static public route', () => {
    expect(buildSitemapPaths([])).toEqual([]);
  });

  it('collects and sorts overlay paths', () => {
    expect(buildSitemapPaths([overlay({ sitemapPaths: ['/b'] }), overlay({ sitemapPaths: ['/a'] })])).toEqual([
      '/a',
      '/b',
    ]);
  });

  it('drops entries that are not origin-relative paths', () => {
    expect(buildSitemapPaths([overlay({ sitemapPaths: ['//evil.test', '/kept'] })])).toEqual(['/kept']);
  });
});

describe('normalizeOrigin', () => {
  it('strips trailing slashes so an appended path cannot double up', () => {
    expect(normalizeOrigin('https://example.test/')).toBe('https://example.test');
    expect(normalizeOrigin('https://example.test///')).toBe('https://example.test');
    expect(normalizeOrigin('https://example.test')).toBe('https://example.test');
  });

  it('passes an unset url through as empty', () => {
    expect(normalizeOrigin('')).toBe('');
  });
});

describe('buildSitemapUrl', () => {
  it('returns an absolute url when there is an origin and something to list', () => {
    expect(buildSitemapUrl('https://example.test/', ['/a'])).toBe('https://example.test/sitemap.xml');
  });

  // Both omissions matter: the spec requires an absolute Sitemap: line, and pointing
  // crawlers at an empty urlset is worse than omitting the line.
  it('omits the line with no configured origin', () => {
    expect(buildSitemapUrl('', ['/a'])).toBeUndefined();
  });

  it('omits the line when the sitemap would be empty', () => {
    expect(buildSitemapUrl('https://example.test', [])).toBeUndefined();
  });
});
