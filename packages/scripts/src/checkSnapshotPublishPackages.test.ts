import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Cross-check the three package lists in snapshot-publish.yaml.
 *
 * The change gate, the `CHANGED_FILES` diff and `PKG_MAP` are three separate literals that must
 * agree, and nothing at runtime catches it when they drift: the job just exits 0 having published
 * nothing. What this enforces:
 *
 *   - the gate and `CHANGED_FILES` name the same roots;
 *   - `CHANGED_FILES` carries no exclusions, and no exclusion in either invocation covers a
 *     root - an exclusion is a pathspec that can negate a root and empty the file list;
 *   - every root has at least one `PKG_MAP` entry, and every entry sits under a root;
 *   - every non-private workspace package under a root has a live `PKG_MAP` row, apart from the
 *     packages in `KNOWN_UNMAPPED`.
 *
 * `KNOWN_UNMAPPED` is a recorded gap, not a design: for each of those packages a branch touching
 * only it opens the gate, lists the file, resolves no npm name and publishes nothing - silently.
 * Pinning the exact set means a new package under these roots cannot join the gap unnoticed, and
 * removing one from it (by adding the missing rows) fails here until the list is updated.
 *
 * Text-matched rather than YAML-parsed on purpose - the repo carries no YAML parser dependency,
 * and the assertion is over literal shell tokens. Comment lines are dropped first, because bash
 * drops them too: a commented-out row is not a row.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const WORKFLOW = path.join(REPO_ROOT, '.github', 'workflows', 'snapshot-publish.yaml');

/** Non-private workspace packages under the diff roots that have no `PKG_MAP` row today. */
const KNOWN_UNMAPPED = [
  'b4m-core/client-auth',
  'b4m-core/hearth',
  'b4m-core/memory',
  'b4m-core/resource',
  'b4m-core/voice',
];

/**
 * Tokens of a `git diff ... main...HEAD --` pathspec operand.
 *
 * Quote-aware, and stops only at an unquoted `;` or `)`: an exclusion pathspec contains a `)`
 * itself, so a capture that ends at `)` truncates the list inside `':(exclude)...'` and hides
 * everything after the first exclusion.
 */
function tokenizePathspecs(operand: string): string[] {
  const tokens: string[] = [];
  let token = '';
  let quote = '';
  for (const char of operand) {
    if (quote) {
      if (char === quote) quote = '';
      else token += char;
    } else if (char === "'" || char === '"') {
      quote = char;
    } else if (char === ';' || char === ')') {
      break;
    } else if (/\s/.test(char)) {
      if (token) tokens.push(token);
      token = '';
    } else {
      token += char;
    }
  }
  if (token) tokens.push(token);
  return tokens;
}

/** Short and long form of a git exclusion pathspec. */
const EXCLUSION = /^(?::!|:\(exclude\b[^)]*\))/;

const isExclusion = (token: string) => EXCLUSION.test(token);

/**
 * Pathspec tokens of every `git diff ... main...HEAD -- <pathspecs>` invocation, after joining
 * backslash continuations. Exclusions are kept: they can negate a root, so the assertions have to
 * see them even though they are not roots themselves.
 */
function extractPathspecLists(workflow: string): { tokens: string[]; quiet: boolean; nameOnly: boolean }[] {
  const joined = workflow.replace(/\\\r?\n\s*/g, ' ');
  return [...joined.matchAll(/git diff\b([^\n]*?)main\.\.\.HEAD --([^\n]*)/g)].map(match => ({
    tokens: tokenizePathspecs(match[2]),
    quiet: /--quiet\b/.test(match[1]),
    nameOnly: /--name-only\b/.test(match[1]),
  }));
}

/** The `declare -A PKG_MAP=(...)` directory -> npm package name mapping, comment lines dropped. */
function extractPackageMap(workflow: string): Map<string, string> {
  const block = /declare -A PKG_MAP=\(([\s\S]*?)\n\s*\)/.exec(workflow)?.[1] ?? '';
  const map = new Map<string, string>();
  for (const line of block.split('\n')) {
    if (/^\s*#/.test(line)) continue;
    for (const match of line.matchAll(/\["([^"]+)"\]="([^"]+)"/g)) {
      map.set(match[1], match[2]);
    }
  }
  return map;
}

/** Diff roots named by an invocation, trailing slashes removed. */
const positiveRoots = (invocation: { tokens: string[] }) =>
  invocation.tokens.filter(token => !isExclusion(token)).map(token => token.replace(/\/$/, ''));

/** The bare pattern of an exclusion token: `:(exclude,glob)foo` -> `foo`. */
const exclusionPattern = (token: string) => token.replace(EXCLUSION, '');

/** Git pathspec glob (glob magic) as a matcher; `**` spans directories, `*` and `?` do not. */
function globToRegExp(pattern: string): RegExp {
  let source = '';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === '*' && pattern[i + 1] === '*') {
      source += '.*';
      i++;
    } else if (char === '*') {
      source += '[^/]*';
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/, '\\$&');
    }
  }
  return new RegExp(`^${source}$`);
}

/** Repo-relative directories of the non-private packages sitting at or directly under a root. */
function listWorkspacePackages(roots: string[]): string[] {
  const dirs = new Set<string>();
  for (const root of roots) {
    const absolute = path.join(REPO_ROOT, root);
    const candidates = [root];
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
      if (entry.isDirectory()) candidates.push(`${root}/${entry.name}`);
    }
    for (const candidate of candidates) {
      const manifest = path.join(REPO_ROOT, candidate, 'package.json');
      if (!fs.existsSync(manifest)) continue;
      const { private: isPrivate } = JSON.parse(fs.readFileSync(manifest, 'utf8')) as {
        private?: boolean;
      };
      if (!isPrivate) dirs.add(candidate);
    }
  }
  return [...dirs].sort();
}

describe('snapshot-publish package lists', () => {
  const workflow = fs.readFileSync(WORKFLOW, 'utf8');
  const invocations = extractPathspecLists(workflow);
  const pkgMap = extractPackageMap(workflow);

  const isUnder = (dir: string, root: string) => dir === root || dir.startsWith(`${root}/`);
  const roots = invocations.flatMap(invocation => (invocation.quiet ? positiveRoots(invocation) : []));

  it('parses the same roots out of both diff invocations', () => {
    const expected = ['b4m-core', 'packages/cli', 'packages/sdk'];
    expect(invocations.map(positiveRoots)).toEqual([expected, expected]);
  });

  it('leaves the CHANGED_FILES diff unfiltered', () => {
    const listing = invocations.filter(invocation => invocation.nameOnly);
    expect(listing).toHaveLength(1);
    expect(listing[0].tokens.filter(isExclusion)).toEqual([]);
  });

  it('never lets an exclusion cover a diff root', () => {
    const covering = invocations.flatMap(invocation =>
      invocation.tokens.filter(isExclusion).flatMap(exclusion => {
        const matcher = globToRegExp(exclusionPattern(exclusion));
        return positiveRoots(invocation)
          .filter(root => matcher.test(root) || matcher.test(`${root}/probe.ts`))
          .map(root => `${exclusion} covers ${root}`);
      })
    );
    expect(covering).toEqual([]);
  });

  it('maps every root to at least one package', () => {
    for (const root of roots) {
      expect([...pkgMap.keys()].some(dir => isUnder(dir, root))).toBe(true);
    }
  });

  it('registers every mapped package under a diff root', () => {
    for (const dir of pkgMap.keys()) {
      expect(roots.some(root => isUnder(dir, root))).toBe(true);
    }
  });

  it('maps every non-private workspace package except the recorded gap', () => {
    const unmapped = listWorkspacePackages(roots).filter(
      dir => ![...pkgMap.keys()].some(mapped => isUnder(dir, mapped))
    );
    expect(unmapped).toEqual(KNOWN_UNMAPPED);
  });

  it('maps the SDK and CLI roots to their npm names', () => {
    expect(pkgMap.get('packages/sdk')).toBe('@bike4mind/sdk');
    expect(pkgMap.get('packages/cli')).toBe('@bike4mind/cli');
  });

  it('ignores a commented-out PKG_MAP row', () => {
    const fixture = [
      'declare -A PKG_MAP=(',
      '  ["b4m-core/agents"]="@bike4mind/agents"',
      '  # ["packages/sdk"]="@bike4mind/sdk"',
      ')',
    ].join('\n');

    expect([...extractPackageMap(fixture).keys()]).toEqual(['b4m-core/agents']);
  });

  it('keeps pathspecs that follow an exclusion', () => {
    const fixture = [
      'if git diff --quiet main...HEAD -- \\',
      '    b4m-core/ packages/cli/ \\',
      "    ':(exclude)b4m-core/*/docs' \\",
      "    ':(exclude,glob)**/*.md' \\",
      '    packages/foo/; then',
      '  echo "changed"',
      'fi',
      'CHANGED_FILES=$(git diff --name-only main...HEAD -- b4m-core/ packages/cli/)',
    ].join('\n');

    const [gate, listing] = extractPathspecLists(fixture);
    expect(gate).toMatchObject({ quiet: true, nameOnly: false });
    expect(positiveRoots(gate)).toEqual(['b4m-core', 'packages/cli', 'packages/foo']);
    expect(gate.tokens.filter(isExclusion)).toEqual([':(exclude)b4m-core/*/docs', ':(exclude,glob)**/*.md']);
    expect(positiveRoots(listing)).toEqual(['b4m-core', 'packages/cli']);
  });
});
