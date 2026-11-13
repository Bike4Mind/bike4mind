// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const API_ROOT = join(__dirname, '../../pages/api');

/**
 * Routes allowed to set `grandfatherLegacyKeys`. Opting in lets a legacy key past a scope it does
 * not hold, so only a route that every key could reach before it gained scopes may be listed:
 * one that came off the `KNOWN_UNPOSTURED` ledger. Listing a route that already enforced a scope
 * would hand legacy keys access they never had. See baseApi's `grandfatherLegacyKeys` docblock.
 */
const GRANDFATHERED_ROUTES = [
  'ai/transcribe/index.ts',
  'ai/transcribe/init.ts',
  'credits/transactions.ts',
  'gears/status.ts',
  'generated-content/[ref].ts',
  'identify.ts',
  'models.ts',
  'sessions/[id]/chat/index.ts',
  'sessions/index.ts',
  'skills/[id]/index.ts',
  'skills/[id]/share.ts',
  'skills/index.ts',
  'user-api-keys/[id]/index.ts',
  'user-api-keys/[id]/rate-limit.ts',
  'user-api-keys/[id]/revoke.ts',
  'user-api-keys/[id]/rotate.ts',
  'user-api-keys/billing-organizations.ts',
  'user-api-keys/index.ts',
  'users/[id]/index.ts',
];

function listRouteFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : listRouteFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe('grandfatherLegacyKeys opt-ins', () => {
  it('appear only on the routes allowed to grandfather legacy keys', () => {
    const optedIn = listRouteFiles(API_ROOT)
      .filter(file => readFileSync(file, 'utf8').includes('grandfatherLegacyKeys'))
      .map(file => relative(API_ROOT, file))
      .sort();

    expect(optedIn).toEqual([...GRANDFATHERED_ROUTES].sort());
  });
});
