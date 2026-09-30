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

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : tsFiles(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

/**
 * Splits a handler chain into [method, body] pairs - body runs to the next `.method(` or EOF.
 * Only a `.method(` at bracket depth 0 (i.e. chained directly off the `baseApi(...)` call, not
 * nested inside a handler body) opens a new block - tracked by walking the source and counting
 * `([{`/`)]}`. Without this, a route method's OWN body calling something that happens to end in
 * `.delete(`/`.get(` (e.g. `await getFilesStorage().delete(filePath)` inside the real DELETE
 * handler in files/index.ts) is mistaken for a second top-level route method, and the real assert
 * that already covers it gets diluted into a body that doesn't contain it.
 */
function methodBlocks(source: string): Array<{ method: string; body: string }> {
  const opener = /\.(get|post|put|patch|delete)(?:<[^<>]*>)?\(/y;
  const starts: Array<{ method: string; index: number }> = [];
  let depth = 0;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (depth === 0 && ch === '.') {
      opener.lastIndex = i;
      const match = opener.exec(source);
      if (match) starts.push({ method: match[1], index: i });
    }
    if (ch === '(' || ch === '{' || ch === '[') depth++;
    else if (ch === ')' || ch === '}' || ch === ']') depth--;
  }
  return starts.map(({ method, index }, i) => ({
    method,
    body: source.slice(index, starts[i + 1]?.index ?? source.length),
  }));
}

const routes = tsFiles(FILES_API_DIR).map(file => [path.relative(FILES_API_DIR, file), file] as const);

describe('every /api/files door gates API keys on a files scope', () => {
  it('finds the doors', () => {
    expect(routes.length).toBeGreaterThan(0);
  });

  it.each(routes)('%s', (rel, file) => {
    // Strip line comments first so a commented-out `// requiredScopes: ...` does not count, and
    // anchor to the baseApi(...) call itself so a mention anywhere else in the file (e.g. a
    // sibling constant reference) cannot satisfy the gate.
    const source = readFileSync(file, 'utf8').replace(/\/\/[^\n]*/g, '');
    const gate = source.match(
      /baseApi\(\{[^}]*requiredScopes:\s*(FILES_(?:READ|WRITE|READ_OR_WRITE)_SCOPES)\b[^}]*\}\)/
    )?.[1];
    expect(gate, 'declare baseApi({ requiredScopes: FILES_*_SCOPES }) from @server/files/fileScopes').toBeDefined();

    const expectedGate = EXPECTED_GATES[rel];
    expect(expectedGate, `${rel} has no EXPECTED_GATES entry - add one so this route's scope is pinned`).toBeDefined();
    expect(gate, `${rel} must stay pinned to ${expectedGate}`).toBe(expectedGate);

    if (gate !== 'FILES_READ_OR_WRITE_SCOPES') return;
    // The route gate admits either scope, so each method must narrow to its own - a
    // presence-only check ("assertFilesWriteScope appears somewhere in the file") would still
    // pass a route where a later mutating method forgot its own assert.
    for (const { method, body } of methodBlocks(source)) {
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
    const gate = source.match(
      /baseApi\(\{[^}]*requiredScopes:\s*(FILES_(?:READ|WRITE|READ_OR_WRITE)_SCOPES)\b[^}]*\}\)/
    )?.[1];
    expect(gate).toBeUndefined();
  });

  it('ignores a requiredScopes mention living only in a comment', () => {
    const source = [
      '// requiredScopes: FILES_READ_SCOPES',
      'const handler = baseApi({}).get(async (req, res) => {});',
    ].join('\n');
    const stripped = source.replace(/\/\/[^\n]*/g, '');
    const gate = stripped.match(
      /baseApi\(\{[^}]*requiredScopes:\s*(FILES_(?:READ|WRITE|READ_OR_WRITE)_SCOPES)\b[^}]*\}\)/
    )?.[1];
    expect(gate).toBeUndefined();
  });

  it('does not confuse a write door misclassified as FILES_READ_SCOPES with a correct one', () => {
    const gate = 'FILES_READ_SCOPES';
    expect(gate).not.toBe(EXPECTED_GATES['bulk-delete.ts']);
  });
});
