// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import path from 'path';

/**
 * `assertCanWriteDataLakeTags` is the PER-USER authorization gate for writing a lake's
 * `datalake:*` meta-tag through a caller-supplied tag list. It says nothing about API-key scope,
 * so a door under `pages/api` that calls it without also calling `assertDataLakeTagWriteScope`
 * lets any valid API key of an owner who can already reach the lake write into it - the same
 * least-privilege gap `dataLakeApiKeyScopeCoverage.test.ts` closes for `/api/data-lakes` itself,
 * left open on a sibling door outside that prefix.
 *
 * A source scan, not a runtime test, for the same reason as that file: nothing at runtime fails
 * when a new door simply calls the authorization check alone.
 */

// Scanned from outside pages/: an fs-walking test under pages/ is traced as a route and pulls
// the project into the server Lambda (eslint no-restricted-syntax guards it).
const PAGES_API_DIR = path.join(__dirname, '..', '..', 'pages', 'api');

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : tsFiles(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

const filesCallingAuthorizationGate = tsFiles(PAGES_API_DIR).filter(file =>
  readFileSync(file, 'utf8').includes('assertCanWriteDataLakeTags(')
);

describe('doors writing a lake meta-tag also gate the API-key scope', () => {
  it('finds at least one such door', () => {
    expect(filesCallingAuthorizationGate.length).toBeGreaterThan(0);
  });

  it.each(filesCallingAuthorizationGate.map(f => [path.relative(PAGES_API_DIR, f), f]))('%s', (_rel, file) => {
    const source = readFileSync(file, 'utf8');
    expect(
      source,
      'a door writing a lake meta-tag via assertCanWriteDataLakeTags must also call assertDataLakeTagWriteScope'
    ).toContain('assertDataLakeTagWriteScope(');
  });
});

/**
 * `assertCanWriteDataLakeTags` only sees `datalake:*` meta-tags, so it is blind to the OTHER
 * membership signal: a `fileTagPrefix` content tag with no meta-tag involved (see
 * `toggleTags.ts`/`reconcileLakeTags.ts`/`tagService.update`/`tagService.remove`'s own
 * `assertWriteScope` doc comments). None of these service functions calls the authorization gate
 * the guard above scans for, so a door reaching them is invisible to that guard - this one closes
 * the same class of blind spot for those callers specifically, rather than trying to generalize
 * the scan to every indirect path (createFabFile's internal call among them), which would need a
 * call-graph walk, not a text scan.
 */
const PREFIX_ARM_JOIN_CALLERS = ['toggleTags(', 'updateFabFile(', 'tagService.update(', 'tagService.remove('];

const filesCallingPrefixArmJoinPath = tsFiles(PAGES_API_DIR).filter(file => {
  const source = readFileSync(file, 'utf8');
  return PREFIX_ARM_JOIN_CALLERS.some(call => source.includes(call));
});

describe('doors that can join a lake via its prefix arm also thread assertWriteScope', () => {
  it('finds at least one such door', () => {
    expect(filesCallingPrefixArmJoinPath.length).toBeGreaterThan(0);
  });

  it.each(filesCallingPrefixArmJoinPath.map(f => [path.relative(PAGES_API_DIR, f), f]))('%s', (_rel, file) => {
    const source = readFileSync(file, 'utf8');
    expect(
      source,
      'a door calling toggleTags/updateFabFile must forward assertWriteScope so a prefix-arm-only join is not left ungated'
    ).toContain('assertWriteScope');
  });
});

/**
 * The doors above mutate an EXISTING file, so they can diff its stored tags against the
 * request. A door that CREATES a file instead has no stored tags to diff against - for those,
 * `assertDataLakeTagWriteScope` itself resolves the caller's own lakes and checks the prefix arm,
 * via its optional `newFile` argument (see that function's doc comment). Listed by name rather
 * than scanned for a shared call, since these three doors call two different underlying creators
 * (`fabFilesService.createFabFile` vs the file manager's `createFabFile`) with no common substring
 * to key a scan on.
 */
const NEW_FILE_TAG_WRITE_DOORS = [
  path.join(PAGES_API_DIR, 'files', 'createFabFile.ts'),
  path.join(PAGES_API_DIR, 'files', 'generate-presigned-url.ts'),
  path.join(PAGES_API_DIR, 'files', 'generate-presigned-urls-batch.ts'),
];

describe('doors that create a new file also gate its prefix-arm tag signal', () => {
  it.each(NEW_FILE_TAG_WRITE_DOORS.map(f => [path.relative(PAGES_API_DIR, f), f]))('%s', (_rel, file) => {
    const source = readFileSync(file, 'utf8');
    expect(
      source,
      'a door creating a new file with caller-supplied tags must pass a { userId, db } third argument to ' +
        'assertDataLakeTagWriteScope, or a fileTagPrefix content tag can join a lake with no datalake:write scope'
    ).toContain('await assertDataLakeTagWriteScope(');
    // `[^;]*?` bounds the search to the call's own statement (it never spans a `;`), unlike an
    // unbounded `[\s\S]*?`, which was proven to match past the call onto an unrelated `{ userId }`
    // literal elsewhere in the file - so deleting this arg silently passed the guard.
    expect(
      source,
      'a door creating a new file with caller-supplied tags must pass a { userId, db } third argument to ' +
        'assertDataLakeTagWriteScope, or a fileTagPrefix content tag can join a lake with no datalake:write scope'
    ).toMatch(/assertDataLakeTagWriteScope\(\s*req,\s*[^;]*?\{\s*userId/);
  });
});

describe('new-file prefix-arm guard regex', () => {
  const NEW_FILE_ARG_PATTERN = /assertDataLakeTagWriteScope\(\s*req,\s*[^;]*?\{\s*userId/;

  it('matches a real call site that passes the newFile argument', () => {
    const source = 'await assertDataLakeTagWriteScope(req, requestedTagNames, { userId, db: { dataLakes } });';
    expect(NEW_FILE_ARG_PATTERN.test(source)).toBe(true);
  });

  // Regression for the bug this guard previously had: an unbounded `[\s\S]*?` matched past the
  // call's own closing paren onto an unrelated `{ userId }` literal elsewhere in the file, so a
  // door that dropped the newFile argument entirely still passed. Bounding the middle group to
  // `[^;]*?` confines the search to the call's own statement.
  it('does not match when the newFile argument is dropped but an unrelated { userId } appears later', () => {
    const source = [
      'await assertDataLakeTagWriteScope(req, requestedTagNames);',
      'const ctx = await toAccessContext(req);',
      'await someOtherCall(ctx, { userId, extra: true });',
    ].join('\n');
    expect(NEW_FILE_ARG_PATTERN.test(source)).toBe(false);
  });
});
