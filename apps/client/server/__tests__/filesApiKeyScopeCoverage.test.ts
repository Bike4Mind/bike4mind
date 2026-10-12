// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { extractRequiredScopesGate, methodBlocks, stripComments, tsFiles } from './scopeCoverageHelpers';

/**
 * Every `/api/files` door gates API keys on a files scope (server/files/fileScopes.ts). Before
 * this guard, the family was scoped door by door and most doors were missed, so a key minted
 * without `files:*` could still upload and read through a sibling. A source scan, not a runtime
 * test: nothing at runtime fails when a new door simply omits `requiredScopes`.
 */

// Scanned from outside pages/: an fs-walking test under pages/ is traced as a route and pulls
// the project into the server Lambda (eslint no-restricted-syntax guards it).
const FILES_API_DIR = path.join(__dirname, '..', '..', 'pages', 'api', 'files');

/**
 * The gate every route must declare, pinned by hand so a write door silently mislabeled
 * FILES_READ_SCOPES (or vice versa) fails here rather than passing the "some FILES_* constant is
 * present somewhere" check that a bare presence regex would otherwise reduce to.
 */
const EXPECTED_GATES: Record<string, string> = {
  'byIds.ts': 'FILES_READ_SCOPES',
  'check-duplicates.ts': 'FILES_READ_SCOPES',
  'download.ts': 'FILES_READ_SCOPES',
  'getFabFileNameById.ts': 'FILES_READ_SCOPES',
  'presigned-url.ts': 'FILES_READ_SCOPES',
  'search.ts': 'FILES_READ_SCOPES',
  'tags/counts.ts': 'FILES_READ_SCOPES',
  '[id]/upload.ts': 'FILES_WRITE_SCOPES',
  'bulk-delete.ts': 'FILES_WRITE_SCOPES',
  'chunk.ts': 'FILES_WRITE_SCOPES',
  'copy-generated-image.ts': 'FILES_WRITE_SCOPES',
  'createFabFile.ts': 'FILES_WRITE_SCOPES',
  'createFabFileURL.ts': 'FILES_WRITE_SCOPES',
  'generate-presigned-url.ts': 'FILES_WRITE_SCOPES',
  'generate-presigned-urls-batch.ts': 'FILES_WRITE_SCOPES',
  'generate-smart-name.ts': 'FILES_WRITE_SCOPES',
  'reprocess.ts': 'FILES_WRITE_SCOPES',
  'tags/[id].ts': 'FILES_WRITE_SCOPES',
  'tags/toggle.ts': 'FILES_WRITE_SCOPES',
  '[id]/index.ts': 'FILES_READ_OR_WRITE_SCOPES',
  'index.ts': 'FILES_READ_OR_WRITE_SCOPES',
  'tags/index.ts': 'FILES_READ_OR_WRITE_SCOPES',
};

// Normalized to forward slashes like the sibling coverage tests (adminApiKeyScopeCoverage.test.ts,
// apiKeyScopePostureCoverage.test.ts), so EXPECTED_GATES keys don't drift by platform path.sep.
const rel = (f: string) => path.relative(FILES_API_DIR, f).split(path.sep).join('/');

const routes = tsFiles(FILES_API_DIR).map(file => [rel(file), file] as const);

describe('every /api/files door gates API keys on a files scope', () => {
  it('finds the doors', () => {
    expect(routes.length).toBeGreaterThan(0);
  });

  it.each(routes)('%s', (relPath, file) => {
    const rawSource = readFileSync(file, 'utf8');
    const gate = extractRequiredScopesGate(rawSource, 'FILES');
    expect(gate, 'declare baseApi({ requiredScopes: FILES_*_SCOPES }) from @server/files/fileScopes').toBeDefined();

    const expectedGate = EXPECTED_GATES[relPath];
    expect(
      expectedGate,
      `${relPath} has no EXPECTED_GATES entry - add one so this route's scope is pinned`
    ).toBeDefined();
    expect(gate, `${relPath} must stay pinned to ${expectedGate}`).toBe(expectedGate);

    if (gate !== 'FILES_READ_OR_WRITE_SCOPES') return;
    // The route gate admits either scope, so each method must narrow to its own - a
    // presence-only check ("assertFilesWriteScope appears somewhere in the file") would still
    // pass a route where a later mutating method forgot its own assert.
    for (const { method, body } of methodBlocks(stripComments(rawSource))) {
      if (method === 'get') {
        expect(body, '.get on a read-or-write route must assert files:read in-handler').toMatch(
          /assertFilesReadScope\(/
        );
        continue;
      }
      expect(body, `.${method} on a read-or-write route must assert files:write in-handler`).toMatch(
        /assertFilesWriteScope\(/
      );
    }
  });
});

describe('methodBlocks splitter', () => {
  it('recognizes a chained opener with a generic type argument', () => {
    const blocks = methodBlocks(
      'baseApi().post<Foo>(asyncHandler(async (req, res) => { assertFilesWriteScope(req); }))'
    );
    expect(blocks.map(b => b.method)).toEqual(['post']);
  });

  it('does not mistake a local Map.get() call nested in the handler body for a route method', () => {
    const source = [
      'const handler = baseApi({ requiredScopes: FILES_READ_OR_WRITE_SCOPES })',
      '  .post(async (req, res) => {',
      '    const x = userById.get(id);',
      '    assertFilesWriteScope(req);',
      '  });',
    ].join('\n');
    const blocks = methodBlocks(source);
    expect(blocks.map(b => b.method)).toEqual(['post']);
    expect(blocks[0].body).toContain('assertFilesWriteScope(req)');
  });

  // Regression: files/index.ts's real DELETE handler calls `getFilesStorage().delete(filePath)`
  // deep inside its own body. A depth-blind splitter reads that as a second top-level `.delete(`
  // and reports the real handler's own assert as belonging to the WRONG block.
  it('does not mistake a nested storage .delete() call for a second top-level route method', () => {
    const source = [
      'const handler = baseApi({ requiredScopes: FILES_READ_OR_WRITE_SCOPES })',
      '  .delete(async (req, res) => {',
      '    assertFilesWriteScope(req);',
      '    await Promise.all(paths.map(async filePath => {',
      '      await getFilesStorage().delete(filePath);',
      '    }));',
      '  });',
    ].join('\n');
    const blocks = methodBlocks(source);
    expect(blocks.map(b => b.method)).toEqual(['delete']);
    expect(blocks[0].body).toContain('assertFilesWriteScope(req)');
  });

  it('splits a route with both a .get and a .post into separate blocks', () => {
    const source = 'baseApi().get(async () => {}).post(async () => { assertFilesWriteScope(req); })';
    const blocks = methodBlocks(source);
    expect(blocks.map(b => b.method)).toEqual(['get', 'post']);
    expect(blocks[1].body).toContain('assertFilesWriteScope');
  });
});

describe('the gate regex actually rejects a bad door', () => {
  it('fails a route with no requiredScopes at all', () => {
    const source = 'const handler = baseApi({}).get(async (req, res) => {});\nexport default handler;';
    expect(extractRequiredScopesGate(source, 'FILES')).toBeUndefined();
  });

  it('ignores a requiredScopes mention living only in a line comment', () => {
    const source = [
      '// requiredScopes: FILES_READ_SCOPES',
      'const handler = baseApi({}).get(async (req, res) => {});',
    ].join('\n');
    expect(extractRequiredScopesGate(source, 'FILES')).toBeUndefined();
  });

  // A bare `baseApi({})` alongside a block-commented gate must not be recognized as gated - the
  // extractor has to strip `/* ... */` the same way it strips `//`, or a route could ship with its
  // real gate commented out and still pass every check above.
  it('ignores a requiredScopes mention living only in a block comment, and does not gate a bare baseApi({})', () => {
    const source = [
      '/* baseApi({ requiredScopes: FILES_READ_SCOPES }) */',
      'const handler = baseApi({}).get(async (req, res) => {});',
    ].join('\n');
    expect(extractRequiredScopesGate(source, 'FILES')).toBeUndefined();
  });
});
