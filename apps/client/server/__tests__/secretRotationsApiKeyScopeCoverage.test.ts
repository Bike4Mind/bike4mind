// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import path from 'path';

/**
 * The secret-rotations routes gate on the ADMIN API-key scope (admin:* is broad by design and
 * not confined). They live under pages/api/secret-rotations, outside the pages/api/admin tree the
 * adminApiKeyScopeCoverage sweep walks, so nothing pinned their gate before - a route losing it
 * would go unnoticed. This mirrors that sweep and, like it, is scanned from outside pages/ (an
 * fs-walking test under pages/ is traced as a route into the server Lambda).
 */
const ROUTES_DIR = path.join(__dirname, '..', '..', 'pages', 'api', 'secret-rotations');
const ADMIN_GATE = /requiredScopes:\s*\[\s*ApiKeyScope\.ADMIN\s*\]/;

function routeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : routeFiles(full);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [full] : [];
  });
}

const files = routeFiles(ROUTES_DIR);
const rel = (f: string) => path.relative(ROUTES_DIR, f).split(path.sep).join('/');
// Strip line comments so a commented-out gate does not read as gated (matches the admin sweep).
const isGated = (f: string) => ADMIN_GATE.test(readFileSync(f, 'utf8').replace(/\/\/[^\n]*/g, ''));

describe('secret-rotations routes declare the ADMIN API-key scope gate', () => {
  it('finds the route files', () => {
    expect(files.length).toBeGreaterThanOrEqual(3);
  });

  it.each(files.map(f => [rel(f), f]))('%s is gated on [ApiKeyScope.ADMIN]', (_r, f) => {
    expect(isGated(f)).toBe(true);
  });
});
