// @vitest-environment node
// Pure build-step data with no DOM anywhere in reach; the package default is jsdom.
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

// Spelled out rather than derived from the constant under test. Every assertion below
// that reads CORE_DISALLOWED_PATHS stays green if an entry is deleted from it, so this
// is the one place that would actually notice.
const EXPECTED_CORE_DISALLOWED = [
  '/api/',
  '/serwist/',
  '/login',
  '/register',
  '/activate',
  '/accept-policies',
  '/verify-',
  '/auth',
  '/oauth',
  '/admin',
  '/agent',
  '/artifacts-demo',
  '/deep-agents',
  '/email',
  '/gears',
  '/google-drive',
  '/hearth',
  '/hud',
  '/integrations',
  '/notebooks',
  '/organizations',
  '/profile',
  '/projects',
  '/quests',
  '/skills',
  '/subscribe',
  '/subscriptions',
  '/tutorials',
];

describe('CORE_DISALLOWED_PATHS', () => {
  it('is the exact policy, not whatever the constant happens to say', () => {
    expect([...CORE_DISALLOWED_PATHS]).toEqual(EXPECTED_CORE_DISALLOWED);
  });

  // The capability-token surfaces, each served by pages/api/publish/serve/[...path].ts
  // with an unconditional `X-Robots-Tag: noindex, nofollow` unless the owner opted in.
  // Disallowing any of them would stop a crawler FETCHING the page, so it would never
  // read the noindex it was blocked from seeing - and a token-bearing URL found on some
  // other site could then be URL-indexed, with possession of the URL being the whole
  // access grant. The per-response header is what does this job; robots.txt must not.
  // Asserted as "no pattern MATCHES this URL", not "no pattern starts with this prefix".
  // robots.txt matching is prefix-of-URL, so a bare `Disallow: /a` would block every
  // share link while passing the looks-right version of this check.
  it.each([
    '/p/abc123',
    '/p/abc123/asset.png',
    '/a/shareToken',
    '/a/shareToken/asset.png',
    '/uc/abc123',
    '/embed/abc123',
  ])('leaves the capability-token url %s crawlable', url => {
    const patterns = buildDisallowList([overlay({ disallowPaths: ['/widgets'] })]);
    const matched = patterns.filter(pattern => url.startsWith(pattern));
    expect(matched).toEqual([]);
  });

  // Prefix matching is what lets one entry cover a family; if these stop being covered
  // the list needs the missing siblings spelled out.
  it.each([
    ['/admin-emergency', '/admin'],
    ['/agents', '/agent'],
    ['/agent-executions', '/agent'],
    ['/quests-v5', '/quests'],
    ['/verify-email', '/verify-'],
    ['/verify-change', '/verify-'],
  ])('covers %s by prefix via %s', (route, pattern) => {
    expect(CORE_DISALLOWED_PATHS).toContain(pattern);
    expect(route.startsWith(pattern)).toBe(true);
  });
});

describe('buildDisallowList', () => {
  it('covers every core surface with no overlay installed (the fork build)', () => {
    expect(buildDisallowList([])).toEqual([...EXPECTED_CORE_DISALLOWED].sort());
  });

  it('merges overlay patterns in', () => {
    const result = buildDisallowList([overlay({ disallowPaths: ['/widgets'] })]);
    expect(result).toContain('/widgets');
    for (const path of EXPECTED_CORE_DISALLOWED) expect(result).toContain(path);
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
  // The non-string entries matter too: the array itself is only as typed as the
  // package.json that declared it.
  it('drops entries that are not origin-relative path strings', () => {
    const result = buildDisallowList([
      overlay({
        disallowPaths: [
          '//evil.test',
          'no-leading-slash',
          'https://evil.test/x',
          null,
          undefined,
          42,
          { toString: () => '/x' },
          '/kept',
        ] as unknown as string[],
      }),
    ]);
    expect(result).toContain('/kept');
    expect(result).toEqual([...EXPECTED_CORE_DISALLOWED, '/kept'].sort());
  });

  // Next's metadata serializer interpolates these straight into the file with no
  // escaping at all, so the guard is the only thing standing between a contributed
  // string and the served bytes.
  it('drops a path that would inject extra robots.txt directives', () => {
    const injected = '/x\nUser-agent: Googlebot\nAllow: /';
    const result = buildDisallowList([overlay({ disallowPaths: [injected, '/kept'] })]);
    expect(result).not.toContain(injected);
    expect(result.some(p => p.includes('User-agent'))).toBe(false);
    expect(result).toContain('/kept');
  });

  it.each(['/x\rY', '/x<y', '/x>y', '/x"y', '/x y', "/x'y"])('drops the unsafe path %j', bad => {
    expect(buildDisallowList([overlay({ disallowPaths: [bad] })])).not.toContain(bad);
  });

  it('tolerates an overlay that omits the arrays entirely', () => {
    const malformed = { sitemapPaths: undefined, disallowPaths: undefined } as unknown as PremiumRouteIndexing;
    expect(() => buildDisallowList([malformed])).not.toThrow();
    expect(buildDisallowList([malformed])).toEqual([...EXPECTED_CORE_DISALLOWED].sort());
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

  // A bare `&` is legal in a path but fatal inside <loc>, and it would reject the whole
  // sitemap rather than just the one entry.
  it('drops a path that would make the sitemap XML unparseable', () => {
    expect(buildSitemapPaths([overlay({ sitemapPaths: ['/x?a=1&b=2', '/kept'] })])).toEqual(['/kept']);
  });

  // The two contribution fields are independent, so an overlay can advertise a URL its
  // own disallow forbids. Shipping both would mean zero indexing with nothing to read
  // as an error anywhere.
  it('does not advertise a path its own overlay disallows', () => {
    const conflicted = overlay({ sitemapPaths: ['/widgets/overview'], disallowPaths: ['/widgets/'] });
    expect(buildSitemapPaths([conflicted])).toEqual([]);
  });

  it('suppresses a path covered by ANOTHER overlay disallow, since robots.txt is one file', () => {
    const publisher = overlay({ sitemapPaths: ['/widgets/overview'] });
    const blocker = overlay({ disallowPaths: ['/widgets/'] });
    expect(buildSitemapPaths([publisher, blocker])).toEqual([]);
  });

  it('suppresses a path covered by a core disallow', () => {
    expect(buildSitemapPaths([overlay({ sitemapPaths: ['/profile/public', '/kept'] })])).toEqual(['/kept']);
  });

  it('keeps a sibling the disallow prefix does not actually cover', () => {
    const o = overlay({ sitemapPaths: ['/widgets/overview'], disallowPaths: ['/widgets/admin/'] });
    expect(buildSitemapPaths([o])).toEqual(['/widgets/overview']);
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
