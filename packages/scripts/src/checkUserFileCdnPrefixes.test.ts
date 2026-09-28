import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Guard tying the CDN CSP backstop's prefix list to the routes it is meant to cover.
 *
 * `userFileCdnPrefixes` in infra/router.ts drives which CloudFront responses get the inert
 * `default-src 'none'; sandbox` CSP + nosniff. If someone adds a user-file bucket route in
 * infra/buckets.ts (a `router.routeBucket(...)`) but forgets the matching prefix, that
 * prefix's files ship with NO CSP and NO nosniff - a silent security hole with nothing else
 * to catch it. And `resolveProxyTarget` in appFileProxy.ts (the self-host proxy that serves
 * the same prefixes) must not drift out from under the same list. So the three are pinned
 * here to agree.
 *
 * Text-matched rather than imported, matching checkClientTestShards.test.ts: these files are
 * SST/infra modules that can't be imported into a plain vitest run, and a regex over the
 * literal route strings is exactly the assertion wanted.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const ROUTER_TS = path.join(REPO_ROOT, 'infra', 'router.ts');
const BUCKETS_TS = path.join(REPO_ROOT, 'infra', 'buckets.ts');
const APP_FILE_PROXY_TS = path.join(REPO_ROOT, 'apps', 'client', 'server', 'utils', 'appFileProxy.ts');

// tavern-sounds / tavern-icons are registered by the tavern overlay in gitignored
// infra/premium-generated (contributeTavernInfra), so their routeBucket calls are not in the
// public tree. They are exempt from the buckets.ts <-> router.ts cross-check here; the CSP
// list still carries them so the backstop covers them at runtime.
const OVERLAY_ONLY_PREFIXES = new Set(['tavern-sounds', 'tavern-icons']);

/** The names inside `userFileCdnPrefixes = [ '/generated/', ... ]` in infra/router.ts. */
function readCspPrefixes(contents: string): string[] {
  const block = /const userFileCdnPrefixes = \[([\s\S]*?)\]/.exec(contents);
  if (!block) throw new Error('userFileCdnPrefixes array not found in infra/router.ts');
  return [...block[1].matchAll(/'\/([a-z0-9-]+)\/'/g)].map(m => m[1]);
}

/**
 * The names inside `router.routeBucket(`${routePrefix}/generated`, ...)` in infra/buckets.ts.
 * Matches every `routeBucket(...)` call indiscriminately - it assumes all of them are
 * user-file routes, which holds today but isn't enforced. A future non-user-file
 * `routeBucket` route would be swept in here and forced into `userFileCdnPrefixes` just to
 * keep this test green; it should instead get its own exemption set, alongside
 * `OVERLAY_ONLY_PREFIXES` above.
 */
function readRouteBucketPrefixes(contents: string): string[] {
  return [...contents.matchAll(/routeBucket\(`\$\{routePrefix\}\/([a-z0-9-]+)`/g)].map(m => m[1]);
}

/** The names inside `cdnPath.startsWith('generated/')` in appFileProxy.ts resolveProxyTarget. */
function readProxyPrefixes(contents: string): string[] {
  return [...contents.matchAll(/cdnPath\.startsWith\('([a-z0-9-]+)\/'\)/g)].map(m => m[1]);
}

describe('CDN user-file CSP prefix list stays in sync', () => {
  const cspPrefixes = new Set(readCspPrefixes(fs.readFileSync(ROUTER_TS, 'utf8')));
  const routeBucketPrefixes = readRouteBucketPrefixes(fs.readFileSync(BUCKETS_TS, 'utf8'));
  const proxyPrefixes = readProxyPrefixes(fs.readFileSync(APP_FILE_PROXY_TS, 'utf8'));

  it('extracts non-empty lists from all three files', () => {
    expect(cspPrefixes.size).toBeGreaterThan(0);
    expect(routeBucketPrefixes.length).toBeGreaterThan(0);
    expect(proxyPrefixes.length).toBeGreaterThan(0);
  });

  it('every routeBucket user-file route has a CSP prefix', () => {
    const missing = routeBucketPrefixes.filter(p => !cspPrefixes.has(p));
    expect(missing, `routeBucket prefixes missing from userFileCdnPrefixes: ${missing.join(', ')}`).toEqual([]);
  });

  it('every non-overlay CSP prefix maps to a real route', () => {
    const routes = new Set(routeBucketPrefixes);
    const orphans = [...cspPrefixes].filter(p => !routes.has(p) && !OVERLAY_ONLY_PREFIXES.has(p));
    expect(orphans, `userFileCdnPrefixes with no routeBucket route: ${orphans.join(', ')}`).toEqual([]);
  });

  it('every self-host proxy prefix is covered by the CSP list', () => {
    const missing = proxyPrefixes.filter(p => !cspPrefixes.has(p));
    expect(missing, `resolveProxyTarget prefixes missing from userFileCdnPrefixes: ${missing.join(', ')}`).toEqual([]);
  });
});
