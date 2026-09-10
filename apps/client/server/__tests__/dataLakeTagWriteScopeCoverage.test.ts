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
 * `toggleTags.ts`/`reconcileLakeTags.ts`'s own `assertWriteScope` doc comments). Neither service
 * function calls the authorization gate the guard above scans for, so a door reaching them is
 * invisible to that guard - this one closes the same class of blind spot for those two callers
 * specifically, rather than trying to generalize the scan to every indirect path (createFabFile's
 * internal call among them), which would need a call-graph walk, not a text scan.
 */
const PREFIX_ARM_JOIN_CALLERS = ['toggleTags(', 'updateFabFile('];

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
