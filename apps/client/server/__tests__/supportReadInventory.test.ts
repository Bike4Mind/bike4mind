// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import path from 'path';

/**
 * `support:read` is the read-only support permission: it is declared on GET (and so HEAD) only.
 * A write on it would let every support reader change state, so the few writes it does carry are
 * listed here with the extra check each handler makes. Adding one is a deliberate review step.
 *
 * Billed reads (CloudWatch metrics and Logs Insights behind the security dashboard's firewall view,
 * live GitHub calls) stay on support:read, bounded per user by a route rate limit instead of a
 * separate permission: see wafQueryRateLimit in server/security/wafApiHelpers.ts and the GitHub
 * routes' own limits.
 */
const SUPPORT_READ_WRITES = new Map<string, string>([
  ['admin/approvals/[id]/approve.ts', 'the service also requires the approval own permission, and step-up'],
  ['admin/approvals/[id]/reject.ts', 'the service also requires the approval own permission, or the requester'],
  ['admin/audit-log/reviews.ts', 'assertCanReview requires a full admin for POST and DELETE'],
]);

const API_DIR = path.join(__dirname, '..', '..', 'pages', 'api');

const routeFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : routeFiles(full);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [full] : [];
  });

/** The methods a route's `adminApi` declarations put on support:read, alone or in an any-of list. */
const supportReadMethods = (source: string): string[] =>
  [...source.matchAll(/adminPermissions:\s*\{([^}]*)\}/g)].flatMap(([, declaration]) =>
    [...declaration.matchAll(/(\w+):\s*(\[[^\]]*\]|'[^']*'|\w+)/g)].flatMap(([, method, value]) => {
      if (/^\w+$/.test(value) && value !== 'SETTINGS_PAGE_READ') {
        throw new Error(`Unrecognised permission constant ${value}: teach this test whether it includes support:read`);
      }
      return value.includes("'support:read'") || value === 'SETTINGS_PAGE_READ' ? [method] : [];
    })
  );

const inventory = routeFiles(API_DIR)
  .map(file => ({ route: path.relative(API_DIR, file), methods: supportReadMethods(readFileSync(file, 'utf8')) }))
  .filter(({ methods }) => methods.length > 0);

describe('support:read inventory', () => {
  it('finds the routes it guards', () => {
    expect(inventory.length).toBeGreaterThan(100);
  });

  it('declares support:read on reads only, outside the reviewed writes', () => {
    const unreviewed = inventory
      .filter(({ route, methods }) => !SUPPORT_READ_WRITES.has(route) && methods.some(m => m !== 'GET' && m !== 'HEAD'))
      .map(({ route, methods }) => `${route}: ${methods.join(', ')}`);
    expect(unreviewed).toEqual([]);
  });

  it('lists only reviewed writes that still exist and still write on support:read', () => {
    for (const route of SUPPORT_READ_WRITES.keys()) {
      const entry = inventory.find(item => item.route === route);
      expect(
        entry?.methods.some(m => m !== 'GET' && m !== 'HEAD'),
        route
      ).toBe(true);
    }
  });
});
