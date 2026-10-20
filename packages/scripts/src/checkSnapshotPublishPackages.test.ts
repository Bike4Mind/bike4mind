import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Cross-check the three package lists in snapshot-publish.yaml.
 *
 * The change gate, the `CHANGED_FILES` diff, and `PKG_MAP` are three separate literals that must
 * agree, and nothing at runtime catches it when they drift: a package missing from the gate skips
 * the whole job (no error, no output), a package missing from `CHANGED_FILES` publishes nothing,
 * and a package missing from `PKG_MAP` resolves to no changeset entry. A branch touching only that
 * package then silently publishes no snapshot. Text-matched rather than YAML-parsed on purpose -
 * the repo carries no YAML parser dependency, and the assertion is over literal shell tokens.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const WORKFLOW = path.join(REPO_ROOT, '.github', 'workflows', 'snapshot-publish.yaml');

/**
 * Positive pathspecs of every `git diff ... main...HEAD -- <pathspecs>` invocation.
 *
 * Backslash continuations are joined first, then each invocation's token list ends at the closing
 * `;` or `)` of its shell construct. Exclusion pathspecs (`:(exclude)...`) are not roots.
 */
function extractPathspecLists(workflow: string): string[][] {
  const joined = workflow.replace(/\\\r?\n\s*/g, ' ');
  return [...joined.matchAll(/git diff\b[^\n]*?main\.\.\.HEAD --([^;\n)]*)/g)].map(match =>
    match[1]
      .split(/\s+/)
      .map(token => token.replace(/^['"]|['"]$/g, ''))
      .filter(token => token.length > 0 && !token.startsWith(':(exclude'))
      .map(token => token.replace(/\/$/, ''))
  );
}

/** The `declare -A PKG_MAP=(...)` directory -> npm package name mapping. */
function extractPackageMap(workflow: string): Map<string, string> {
  const block = /declare -A PKG_MAP=\(([\s\S]*?)\n\s*\)/.exec(workflow)?.[1] ?? '';
  const map = new Map<string, string>();
  for (const match of block.matchAll(/\["([^"]+)"\]="([^"]+)"/g)) {
    map.set(match[1], match[2]);
  }
  return map;
}

describe('snapshot-publish package lists', () => {
  const workflow = fs.readFileSync(WORKFLOW, 'utf8');
  const pathspecLists = extractPathspecLists(workflow);
  const pkgMap = extractPackageMap(workflow);

  const isUnder = (dir: string, root: string) => dir === root || dir.startsWith(`${root}/`);

  it('parses every diff invocation', () => {
    expect(pathspecLists).toHaveLength(2);
  });

  it('uses the same roots in the change gate and CHANGED_FILES', () => {
    expect(pathspecLists[0]).toEqual(pathspecLists[1]);
  });

  it('maps every root to at least one package', () => {
    for (const root of pathspecLists[0]) {
      expect([...pkgMap.keys()].some(dir => isUnder(dir, root))).toBe(true);
    }
  });

  it('registers every mapped package under a diff root', () => {
    for (const dir of pkgMap.keys()) {
      expect(pathspecLists[0].some(root => isUnder(dir, root))).toBe(true);
    }
  });

  it('maps the SDK and CLI roots to their npm names', () => {
    expect(pkgMap.get('packages/sdk')).toBe('@bike4mind/sdk');
    expect(pkgMap.get('packages/cli')).toBe('@bike4mind/cli');
  });

  it('parses continued pathspecs and drops exclusions', () => {
    const fixture = [
      'if git diff --quiet main...HEAD -- \\',
      '    b4m-core/ packages/cli/ \\',
      "    ':(exclude)b4m-core/*/docs' \\",
      "    ':(exclude,glob)**/*.md'; then",
      '  echo "changed"',
      'fi',
      'CHANGED_FILES=$(git diff --name-only main...HEAD -- b4m-core/ packages/cli/)',
    ].join('\n');

    expect(extractPathspecLists(fixture)).toEqual([
      ['b4m-core', 'packages/cli'],
      ['b4m-core', 'packages/cli'],
    ]);
  });
});
