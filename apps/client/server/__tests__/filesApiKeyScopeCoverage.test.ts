// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import path from 'path';

/**
 * Every `/api/files` door gates API keys on a files scope (server/files/fileScopes.ts). Before
 * this guard, the family was scoped door by door and most doors were missed, so a key minted
 * without `files:*` could still upload and read through a sibling. A source scan, not a runtime
 * test: nothing at runtime fails when a new door simply omits `requiredScopes`.
 */

// Scanned from outside pages/: an fs-walking test under pages/ is traced as a route and pulls
// the project into the server Lambda (eslint no-restricted-syntax guards it).
const FILES_API_DIR = path.join(__dirname, '..', '..', 'pages', 'api', 'files');

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : tsFiles(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

const routes = tsFiles(FILES_API_DIR).map(file => [path.relative(FILES_API_DIR, file), file]);

describe('every /api/files door gates API keys on a files scope', () => {
  it('finds the doors', () => {
    expect(routes.length).toBeGreaterThan(0);
  });

  it.each(routes)('%s', (_rel, file) => {
    const source = readFileSync(file, 'utf8');
    const gate = source.match(/requiredScopes: (FILES_(?:READ|WRITE|READ_OR_WRITE)_SCOPES)/)?.[1];
    expect(gate, 'declare baseApi({ requiredScopes: FILES_*_SCOPES }) from @server/files/fileScopes').toBeDefined();
    if (gate !== 'FILES_READ_OR_WRITE_SCOPES') return;
    // The route gate admits either scope, so each method must narrow to its own.
    expect(source).toContain('assertFilesReadScope(');
    expect(source).toContain('assertFilesWriteScope(');
  });
});
