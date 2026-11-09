/** @vitest-environment node */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AUTH_NETWORK_PATHS } from '../authNetworkForwarding';

// JA4, ASN and country reach the origin only on the behaviors built from AUTH_NETWORK_PATHS, so a
// route that reads network meta outside them silently stores nulls. This walks every Pages-API
// route that imports the network-meta module and checks it sits under one of those patterns.
const apiRoot = join(__dirname, '..', '..', 'apps', 'client', 'pages', 'api');
const NETWORK_META_IMPORT = /from\s+['"](?:@server\/auth\/networkMeta|(?:\.\.\/)+server\/auth\/networkMeta)['"]/;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap(entry => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return entry === '__tests__' ? [] : walk(full);
    return /\.ts$/.test(entry) && !/\.test\.ts$/.test(entry) ? [full] : [];
  });
}

// pages/api/auth/[strategy]/callback.ts -> /api/auth/[strategy]/callback. The bracket segment is kept:
// it is a single path segment either way, and the patterns below match segment-wise.
function routeOf(file: string): string {
  const rel = relative(apiRoot, file)
    .split(sep)
    .join('/')
    .replace(/\.ts$/, '')
    .replace(/\/index$/, '');
  return `/api/${rel}`;
}

function matches(pattern: string, route: string): boolean {
  const re = new RegExp(
    `^${pattern
      .split('*')
      .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')}$`
  );
  return re.test(route);
}

describe('network-meta route coverage', () => {
  const routes = walk(apiRoot)
    .filter(file => NETWORK_META_IMPORT.test(readFileSync(file, 'utf8')))
    .map(routeOf)
    .sort();

  it('finds the routes that read network meta', () => {
    expect(routes).toContain('/api/otc/verify');
    expect(routes).toContain('/api/auth/[strategy]/callback');
    expect(routes).toContain('/api/stripe/start-payment');
  });

  it.each(routes)('%s is under a behavior that forwards JA4, ASN and country', route => {
    expect(AUTH_NETWORK_PATHS.some(pattern => matches(pattern, route))).toBe(true);
  });

  it('every pattern ends in * so the request function can derive its prefix', () => {
    for (const pattern of AUTH_NETWORK_PATHS) expect(pattern.endsWith('*')).toBe(true);
  });
});
