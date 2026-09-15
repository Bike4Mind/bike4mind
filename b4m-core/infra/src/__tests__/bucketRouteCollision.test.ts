import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Static-analysis guard for the CLAUDE.md "CloudFront Bucket Route Guidelines":
 *
 *   NEVER use a routeBucket() path that matches a Tanstack Router SPA route prefix.
 *
 * SST's Router uses a CloudFront Function with longest-prefix matching. When a
 * routeBucket() path shares a segment-prefix with an SPA route, a hard refresh of
 * the SPA page gets diverted to S3 and returns 403. This has shipped twice
 * (/organizations vs /organizations/$id, and /admin/logos vs /admin) and neither
 * was caught by CI. This test closes that gap with pure string parsing -
 * no AWS calls, no SST imports.
 */

// b4m-core/infra/src/__tests__ -> repo root is four levels up.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const BUCKETS_FILE = resolve(REPO_ROOT, 'infra/buckets.ts');
const ROUTER_FILE = resolve(REPO_ROOT, 'apps/client/app/router.tsx');

/** Split a URL path into its non-empty segments: '/admin/logos' -> ['admin', 'logos']. */
const segs = (p: string): string[] => p.split('/').filter(Boolean);

/**
 * True when `a`'s segments are a prefix of `b`'s (and `a` is not the root).
 * Equal-length paths count as a prefix of each other, catching exact collisions.
 */
const isPrefix = (a: string[], b: string[]): boolean =>
  a.length > 0 && a.length <= b.length && a.every((seg, i) => seg === b[i]);

/**
 * A bucket route and an SPA route collide when either path is a segment-prefix of
 * the other. The two historical bugs collided in opposite directions, so the check
 * must be bidirectional.
 */
const collides = (bucketPath: string, spaPath: string): boolean => {
  const a = segs(bucketPath);
  const b = segs(spaPath);
  return isPrefix(a, b) || isPrefix(b, a);
};

/** Count every `routeBucket(` call site, regardless of how its path argument is written. */
const countBucketCallSites = (source: string): number => [...source.matchAll(/\brouteBucket\(/g)].length;

/**
 * Extract production bucket-route paths, stripping the `${routePrefix}` template prefix.
 *
 * This only matches the established `routeBucket(`${routePrefix}/foo`` convention. A future
 * call written any other way (string literal, variable, no prefix) is silently skipped by
 * this regex - so the suite cross-checks the captured count against `countBucketCallSites()`
 * below and fails loudly if any call site is missed, rather than letting a partial parse pass
 * vacuously (the `>=5` floor only catches catastrophic, not partial, regex breakage).
 */
const extractBucketPaths = (source: string): string[] => {
  const matches = source.matchAll(/routeBucket\(\s*`\$\{routePrefix\}([^`]*)`/g);
  return [...matches].map(m => m[1]);
};

/**
 * Extract every `path: '...'` literal declared in the Tanstack Router config.
 *
 * Intentionally over-permissive: it grabs any `path:` string in the file, not just route
 * definitions. Extra entries are harmless here - they only matter if one collides with a
 * bucket route - so cheap parsing beats standing up an AST.
 */
const extractSpaPaths = (source: string): string[] => {
  const matches = source.matchAll(/path:\s*'([^']*)'/g);
  return [...matches].map(m => m[1]);
};

describe('collides() detector', () => {
  it('flags a bucket route that is a prefix of an SPA route (#9047)', () => {
    expect(collides('/organizations', '/organizations/$id')).toBe(true);
  });

  it('flags an SPA route that is a prefix of a bucket route (#9065/#9131)', () => {
    expect(collides('/admin/logos', '/admin')).toBe(true);
  });

  it('flags exact-match paths', () => {
    expect(collides('/admin', '/admin')).toBe(true);
  });

  it('allows the remapped /org-files route', () => {
    expect(collides('/org-files', '/organizations/$id')).toBe(false);
  });

  it('allows the remapped /admin-logos route', () => {
    expect(collides('/admin-logos', '/admin')).toBe(false);
  });

  it('does not treat shared string prefixes (non-segment) as collisions', () => {
    expect(collides('/profile-photos', '/profile')).toBe(false);
    expect(collides('/admin-logos', '/admin-emergency')).toBe(false);
  });

  it('never collides with the SPA root', () => {
    expect(collides('/generated', '/')).toBe(false);
  });
});

describe('infra routeBucket() vs SPA route collisions', () => {
  const bucketSource = readFileSync(BUCKETS_FILE, 'utf8');
  const routerSource = readFileSync(ROUTER_FILE, 'utf8');

  const bucketPaths = extractBucketPaths(bucketSource);
  const bucketCallSites = countBucketCallSites(bucketSource);
  const spaPaths = extractSpaPaths(routerSource);

  it('parses bucket and SPA routes (guards against a silently-broken regex)', () => {
    // Loose canaries - current counts are 9 bucket routes and 55 SPA paths, so these floors
    // have ample headroom. They exist to catch *catastrophic* regex breakage (e.g. a refactor
    // that makes extraction return nothing), not to assert exact counts.
    expect(bucketPaths.length).toBeGreaterThanOrEqual(5);
    expect(spaPaths.length).toBeGreaterThanOrEqual(20);

    // Tight cross-check: every `routeBucket(` call site must be captured by the path regex.
    // If a future call is written in a form the regex doesn't match, the path-extraction
    // would silently skip it (and skip collision-checking it) - this catches that partial
    // miss instead of letting it pass.
    expect(
      bucketPaths.length,
      `Parsed ${bucketPaths.length} routeBucket() path(s) but found ${bucketCallSites} ` +
        `routeBucket( call site(s) in infra/buckets.ts. A call is written in a form the path ` +
        `regex doesn't match (expected routeBucket(\`\${routePrefix}/...\`)), so it's being ` +
        `skipped by the collision check. Update extractBucketPaths() to cover the new form.`
    ).toBe(bucketCallSites);
  });

  it('has no bucket route colliding with any SPA route prefix', () => {
    const collisions = bucketPaths.flatMap(bucketPath =>
      spaPaths
        .filter(spaPath => collides(bucketPath, spaPath))
        .map(spaPath => `routeBucket("${bucketPath}") collides with SPA route "${spaPath}"`)
    );

    expect(
      collisions,
      collisions.length === 0
        ? ''
        : `Found ${collisions.length} CloudFront bucket-route / SPA-route collision(s):\n` +
            `${collisions.map(c => `  - ${c}`).join('\n')}\n\n` +
            `Rename the bucket route to a non-overlapping prefix (e.g. /org-files instead of ` +
            `/organizations) and add a "rewrite" mapping it back to the S3 key prefix. See ` +
            `CLAUDE.md "CloudFront Bucket Route Guidelines".`
    ).toEqual([]);
  });
});
