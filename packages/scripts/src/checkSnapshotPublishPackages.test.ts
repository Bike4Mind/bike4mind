import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
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
 *     publishable path under a root - an exclusion is a pathspec that can silently empty the file
 *     list while the job exits 0 having published nothing. Both questions are put to `git` over the
 *     tracked tree: magic keywords, bracket expressions and the default-vs-glob wildcard rules all
 *     change what a token hides, so a hand-written matcher under-approximates it;
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
  'b4m-core/local-models',
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

/**
 * Long form (`:(exclude)`, `:(exclude,glob)`, `:(glob,exclude)`) and both short forms (`:!`, `:^`).
 */
const EXCLUSION = /^(?::[!^]|:\((?=[^)]*\bexclude\b)[^)]*\))/;

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

/** Tracked paths under `pathspecs`, exactly as git resolves them. */
function lsFiles(cwd: string, pathspecs: string[]): string[] {
  const out = execFileSync('git', ['ls-files', '-z', '--', ...pathspecs], { cwd, encoding: 'utf8' });
  return out.split('\0').filter(Boolean);
}

/** Paths the gate may exclude on purpose: docs, markdown, and test files or directories. */
const isNonPublishable = (file: string) =>
  file.endsWith('.md') ||
  `/${file}`.includes('/docs/') ||
  /\/(?:test|__tests__|test-utils)\//.test(`/${file}`) ||
  /\.(?:test|spec)\.tsx?$/.test(file);

/**
 * `"<exclusion> hides <root> (<path>)"` for every exclusion that hides a publishable tracked path
 * under a root of its invocation.
 *
 * Git answers the question, not a matcher written here: an exclusion is legal only while the paths
 * it removes stay inside the docs/markdown/test class, and only git knows which paths those are for
 * a given spelling. A directory exclusion, a default-wildmatch glob and a deep match all miss the
 * root path itself while still emptying the gate for a branch that only touches sources - the
 * silent no-publish this file exists to prevent.
 */
function hiddenRoots(invocations: { tokens: string[] }[], cwd: string = REPO_ROOT): string[] {
  return invocations.flatMap(invocation => {
    const roots = positiveRoots(invocation);
    const tracked = lsFiles(cwd, roots);
    return invocation.tokens.filter(isExclusion).flatMap(exclusion => {
      const visible = new Set(lsFiles(cwd, [...roots, exclusion]));
      const hidden = tracked.filter(file => !visible.has(file) && !isNonPublishable(file));
      return roots
        .filter(root => hidden.some(file => isUnder(file, root)))
        .map(root => `${exclusion} hides ${root} (${hidden.find(file => isUnder(file, root))})`);
    });
  });
}

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

/** A throwaway git repository holding `files` (empty), so a spelling is pinned against a known tree. */
function fixtureRepo(files: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-publish-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), '');
  }
  execFileSync('git', ['add', '-A'], { cwd: dir });
  return dir;
}

const isUnder = (dir: string, root: string) => dir === root || dir.startsWith(`${root}/`);

describe('snapshot-publish package lists', () => {
  const workflow = fs.readFileSync(WORKFLOW, 'utf8');
  const invocations = extractPathspecLists(workflow);
  const pkgMap = extractPackageMap(workflow);

  const roots = invocations.flatMap(invocation => (invocation.quiet ? positiveRoots(invocation) : []));

  /** A gate invocation over the real roots plus the given exclusion tokens. */
  const gateWith = (exclusions: string[]) =>
    `if git diff --quiet main...HEAD -- b4m-core/ packages/cli/ packages/sdk/ ${exclusions
      .map(exclusion => `'${exclusion}'`)
      .join(' ')}; then\n  echo changed\nfi`;

  /** A tree with one publishable source, docs and test file per root, for the spelling fixtures. */
  const FIXTURE_FILES = [
    'b4m-core/agents/docs/guide.md',
    'b4m-core/agents/src/index.ts',
    'packages/cli/docs/guide.md',
    'packages/cli/src/App.tsx',
    'packages/cli/src/index.ts',
    'packages/sdk/README.md',
    'packages/sdk/docs/guide.md',
    'packages/sdk/package.json',
    'packages/sdk/src/__tests__/client.test.ts',
    'packages/sdk/src/client.ts',
    'packages/sdk/src/generated/openapi.ts',
    'packages/sdk/src/generated/operations.ts',
    'packages/sdk/src/index.ts',
    'packages/sdk/src/test/helpers.ts',
    'packages/sdk/src/test-utils/setup.ts',
    'packages/sdk/src/utils/impl.ts',
    'packages/sdk/src/widget.spec.ts',
    'packages/sdk/src/widget.test.tsx',
  ];

  const inFixtureRepo = (body: (dir: string) => void) => {
    const dir = fixtureRepo(FIXTURE_FILES);
    try {
      body(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

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
    expect(hiddenRoots(invocations)).toEqual([]);
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
      ':(exclude)packages/sdk/src/generated/openapi.ts',
      ':(exclude,glob)packages/sdk/src/*.[jt]s',
      ':(exclude,glob)packages/sdk/src/utils/**',
      ':(exclude,glob)**/*.tsx',
      ':(exclude)packages/sdk/package.json',
      ':(exclude)packages/sdk/',
      ':!packages/sdk/',
      ':^packages/sdk/',
      ':(exclude)packages*',
      ':(exclude)packages/*.ts',
      ':(exclude)*.ts',
      ':(exclude)packages/sdk/**/index.ts',
      ':(exclude)packages/sdk/**/generated/**',
    ];

    inFixtureRepo(dir => {
      const [gate] = extractPathspecLists(gateWith(spellings));
      const flagged = hiddenRoots([gate], dir);
      for (const exclusion of spellings) {
        expect(
          flagged.some(entry => entry.startsWith(`${exclusion} hides `)),
          exclusion
        ).toBe(true);
      }
    });
  });

  it('names the root and the hidden path in a failure', () => {
    inFixtureRepo(dir => {
      const [gate] = extractPathspecLists(gateWith([':(exclude)packages/sdk/src/generated/openapi.ts']));
      expect(hiddenRoots([gate], dir)).toEqual([
        ':(exclude)packages/sdk/src/generated/openapi.ts hides packages/sdk (packages/sdk/src/generated/openapi.ts)',
      ]);
    });
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

    inFixtureRepo(dir => {
      const [gate] = extractPathspecLists(gateWith(allowed));
      expect(hiddenRoots([gate], dir)).toEqual([]);
    });
  });

  it('accepts an exclusion git applies to nothing', () => {
    inFixtureRepo(dir => {
      const [gate] = extractPathspecLists(gateWith([':(exclude,glob)packages/sdk/src/*/']));
      expect(hiddenRoots([gate], dir)).toEqual([]);
    });
  });
});
