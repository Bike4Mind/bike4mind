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
 *   - `CHANGED_FILES` carries no exclusions, and no exclusion in either invocation hides a
 *     publishable source path under a root - an exclusion is a pathspec that can silently empty
 *     the file list while the job exits 0 having published nothing;
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

/** Short form, and the long form in any keyword order (`:(exclude)`, `:(exclude,glob)`, `:(glob,exclude)`). */
const EXCLUSION = /^(?::!|:\((?=[^)]*\bexclude\b)[^)]*\))/;

/** Long-form `glob` magic, which switches git from default wildmatch to segment-bounded wildcards. */
const GLOB_MAGIC = /^:(?=[^)]*\bglob\b)/;

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

/**
 * An exclusion pathspec as a matcher, following git rather than the way the pattern looks.
 *
 * `:(glob)` magic keeps `*` and `?` inside one path segment and lets `**` span directories, while a
 * `**` segment also matches zero directories - so a pattern with a nested `**` still covers the
 * file next to it. Without the magic git uses default wildmatch, where `*` and `?` cross `/`, which
 * is why `:(exclude)packages*` swallows every root.
 */
function pathspecMatcher(token: string): RegExp {
  const glob = GLOB_MAGIC.test(token);
  const pattern = exclusionPattern(token).replace(/^\.\//, '').replace(/\/+$/, '');
  let source = '';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === '*' && glob && pattern[i + 1] === '*') {
      if (pattern[i + 2] === '/') {
        source += '(?:.*/)?';
        i += 2;
      } else {
        source += '.*';
        i += 1;
      }
    } else if (char === '*') {
      source += glob ? '[^/]*' : '.*';
    } else if (char === '?') {
      source += glob ? '[^/]' : '.';
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`);
}

/**
 * Would this exclusion hide `file`? A pathspec also matches a leading directory of the path, and a
 * trailing slash makes it match directories only.
 */
function excludes(token: string, file: string): boolean {
  const matcher = pathspecMatcher(token);
  const segments = file.split('/');
  const directories = segments.slice(0, -1).map((_, index) => segments.slice(0, index + 1).join('/'));
  const candidates = exclusionPattern(token).endsWith('/') ? directories : [file, ...directories];
  return candidates.some(candidate => matcher.test(candidate));
}

/**
 * `"<exclusion> hides <root>"` for every exclusion that can hide a publishable source path under a
 * root of its invocation.
 *
 * Judged against source paths rather than the root path itself: a directory exclusion, a
 * default-wildmatch glob and a deep match all miss the root while still emptying the gate for a
 * branch that only touches sources - the silent no-publish this file exists to prevent.
 */
function hiddenRoots(invocations: { tokens: string[] }[], probes: string[]): string[] {
  return invocations.flatMap(invocation =>
    invocation.tokens.filter(isExclusion).flatMap(exclusion =>
      positiveRoots(invocation)
        .filter(root => probes.some(probe => isUnder(probe, root) && excludes(exclusion, probe)))
        .map(root => `${exclusion} hides ${root}`)
    )
  );
}

/** Source-like paths a branch may publish, relative to a package directory. */
const SOURCE_PROBES = [
  'index.ts',
  'src/index.ts',
  'src/generated/index.ts',
  'src/types/generated/api.ts',
  'src/deep/nested/impl.ts',
];

/** Repo-relative packages sitting at or directly under a root, with their `private` flag. */
function listPackages(roots: string[]): { dir: string; isPrivate: boolean }[] {
  const packages = new Map<string, boolean>();
  for (const root of roots) {
    const children = fs
      .readdirSync(path.join(REPO_ROOT, root), { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => `${root}/${entry.name}`);
    for (const candidate of [root, ...children]) {
      const manifest = path.join(REPO_ROOT, candidate, 'package.json');
      if (!fs.existsSync(manifest)) continue;
      const { private: isPrivate } = JSON.parse(fs.readFileSync(manifest, 'utf8')) as {
        private?: boolean;
      };
      packages.set(candidate, Boolean(isPrivate));
    }
  }
  return [...packages].sort(([a], [b]) => a.localeCompare(b)).map(([dir, isPrivate]) => ({ dir, isPrivate }));
}

/** Paths an exclusion would hide if it covered a root: each package and its source-like files. */
const sourceProbes = (roots: string[]): string[] =>
  listPackages(roots).flatMap(({ dir }) => [dir, ...SOURCE_PROBES.map(probe => `${dir}/${probe}`)]);

const isUnder = (dir: string, root: string) => dir === root || dir.startsWith(`${root}/`);

describe('snapshot-publish package lists', () => {
  const workflow = fs.readFileSync(WORKFLOW, 'utf8');
  const invocations = extractPathspecLists(workflow);
  const pkgMap = extractPackageMap(workflow);

  const roots = invocations.flatMap(invocation => (invocation.quiet ? positiveRoots(invocation) : []));
  const probes = sourceProbes(roots);

  /** A gate invocation over the real roots plus the given exclusion tokens. */
  const gateWith = (exclusions: string[]) =>
    `if git diff --quiet main...HEAD -- b4m-core/ packages/cli/ packages/sdk/ ${exclusions
      .map(exclusion => `'${exclusion}'`)
      .join(' ')}; then\n  echo changed\nfi`;

  /** Fixed probes for the fixtures below, so a spelling class is pinned independently of the live roots. */
  const fixtureProbes = [
    'b4m-core/agents/src/index.ts',
    'b4m-core/agents/src/generated/index.ts',
    'packages/cli/src/index.ts',
    'packages/sdk',
    'packages/sdk/index.ts',
    'packages/sdk/src/index.ts',
    'packages/sdk/src/generated/types.ts',
  ];

  it('parses the same roots out of both diff invocations', () => {
    const expected = ['b4m-core', 'packages/cli', 'packages/sdk'];
    expect(invocations.map(positiveRoots)).toEqual([expected, expected]);
  });

  it('leaves the CHANGED_FILES diff unfiltered', () => {
    const listing = invocations.filter(invocation => invocation.nameOnly);
    expect(listing).toHaveLength(1);
    expect(listing[0].tokens.filter(isExclusion)).toEqual([]);
  });

  it('never lets an exclusion hide a publishable source path', () => {
    expect(hiddenRoots(invocations, probes)).toEqual([]);
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
    const unmapped = listPackages(roots)
      .filter(({ isPrivate }) => !isPrivate)
      .map(({ dir }) => dir)
      .filter(dir => ![...pkgMap.keys()].some(mapped => isUnder(dir, mapped)));
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

  it('flags every exclusion spelling that can hide a root', () => {
    const spellings = [
      ':(exclude)packages/sdk/',
      ':!packages/sdk/',
      ':(exclude)packages*',
      ':(exclude)packages/*.ts',
      ':(exclude)*.ts',
      ':(exclude)packages/sdk/**/index.ts',
      ':(exclude)packages/sdk/**/generated/**',
    ];

    const [gate] = extractPathspecLists(gateWith(spellings));
    const flagged = hiddenRoots([gate], fixtureProbes);
    for (const exclusion of spellings) {
      expect(
        flagged.some(entry => entry.startsWith(`${exclusion} hides `)),
        exclusion
      ).toBe(true);
    }
  });

  it('accepts exclusions that only hide docs, markdown and tests', () => {
    const allowed = [
      ':(exclude)b4m-core/*/docs',
      ':(exclude)packages/cli/docs',
      ':(exclude)packages/sdk/docs',
      ':(exclude,glob)**/*.md',
      ':(exclude,glob)**/test/**',
      ':(exclude,glob)**/__tests__/**',
      ':(exclude,glob)**/test-utils/**',
      ':(exclude,glob)**/*.test.ts',
      ':(exclude,glob)**/*.test.tsx',
      ':(exclude,glob)**/*.spec.ts',
      ':(exclude,glob)**/*.spec.tsx',
    ];

    const [gate] = extractPathspecLists(gateWith(allowed));
    expect(hiddenRoots([gate], fixtureProbes)).toEqual([]);
  });
});
