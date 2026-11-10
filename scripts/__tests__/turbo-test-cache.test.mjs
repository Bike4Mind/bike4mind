import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONTEXT_FILE,
  WHOLE_REPO_TEST_PACKAGES,
  buildContexts,
  formatReport,
  staleCacheEntries,
  summarizeRun,
} from '../turbo-test-cache.mjs';

// CI skips a package's tests when its turbo hash matches a cached pass, so a file a test reads
// that is not in that hash turns into a false green. These guards pin the pieces that keep the
// hash honest: the context file on every test task, and an input (or the whole-repo list) for
// every read that leaves the package.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TEST_TASKS = ['test', 'test:integration'];

// turbo.json is JSONC; every comment in it is a whole line.
function readTurboJson() {
  const text = fs.readFileSync(path.join(repoRoot, 'turbo.json'), 'utf8');
  return JSON.parse(text.replace(/^\s*\/\/.*$/gm, ''));
}

function testTaskEntries(turbo) {
  return Object.entries(turbo.tasks).filter(([name]) => TEST_TASKS.includes(name.split('#').at(-1)));
}

function workspacePackages() {
  return execFileSync(
    'git',
    ['ls-files', 'apps/*/package.json', 'b4m-core/*/package.json', 'packages/*/package.json'],
    {
      cwd: repoRoot,
      encoding: 'utf8',
    }
  )
    .split('\n')
    .filter(Boolean)
    .map(file => ({
      dir: path.dirname(file),
      manifest: JSON.parse(fs.readFileSync(path.join(repoRoot, file), 'utf8')),
    }))
    .filter(({ manifest }) => TEST_TASKS.some(task => manifest.scripts?.[task]));
}

function testFiles(dir) {
  return execFileSync('git', ['ls-files', dir], { cwd: repoRoot, encoding: 'utf8' })
    .split('\n')
    .filter(file => /\.(test|spec)\.[cm]?[jt]sx?$/.test(file) || /\/(__tests__|test-utils?|testUtils)\//.test(file))
    .filter(file => /\.[cm]?[jt]sx?$/.test(file));
}

// An exec of `git grep` / `git ls-files` / `git rev-parse --show-toplevel`, not a command string a
// shell-tool test feeds its parser.
const GIT_SCAN =
  /['"`]git['"`]\s*,\s*\[\s*['"`](grep|ls-files|rev-parse['"`]\s*,\s*['"`]--show-toplevel)['"`]|exec(File)?Sync\(\s*['"`]git (grep|ls-files|rev-parse --show-toplevel)\b/;
// A package's whole-repo reads live in `*.repo.test.*` files, which its `test:repo` script runs and
// CI never caches (the "Run repo-scan tests" step), so they stay out of the `test` hash.
const REPO_LANE_FILE = /\.repo\.test\.[cm]?[jt]sx?$/;
const CLIMBING_LITERAL = /['"`](\.\.(?:\/[^'"`\s$]*)?)['"`]/g;

/** Repo-relative paths a package's test files name with a `..` literal that leaves the package. */
function escapedPaths(dir, files) {
  const escaped = new Set();
  for (const file of files) {
    const source = fs.readFileSync(path.join(repoRoot, file), 'utf8');
    for (const [, literal] of source.matchAll(CLIMBING_LITERAL)) {
      const target = path.relative(repoRoot, path.resolve(repoRoot, path.dirname(file), literal));
      // Above the repo, or a path that does not exist (a traversal fixture such as
      // `../../etc/passwd`): no repo file to hash.
      if (target.startsWith('..') || !fs.existsSync(path.join(repoRoot, target))) continue;
      if (target !== dir && !target.startsWith(`${dir}/`)) escaped.add(target === '' ? '.' : target);
    }
  }
  return [...escaped];
}

// A declared workspace dependency's build inputs are already in the hash through ^build.
function dependencySources(manifest, packages) {
  const declared = new Set(
    Object.keys({ ...manifest.dependencies, ...manifest.devDependencies, ...manifest.peerDependencies })
  );
  return packages.filter(pkg => declared.has(pkg.manifest.name)).map(pkg => `${pkg.dir}/src/**`);
}

function inputCovers(dir, inputs, target) {
  return inputs
    .filter(glob => !glob.startsWith('!') && glob !== '$TURBO_DEFAULT$')
    .map(glob =>
      glob.startsWith('$TURBO_ROOT$/')
        ? glob.slice('$TURBO_ROOT$/'.length)
        : path.relative(repoRoot, path.resolve(repoRoot, dir, glob))
    )
    .some(glob => path.matchesGlob(target, glob) || path.matchesGlob(`${target}/x`, glob));
}

describe('turbo.json test tasks', () => {
  const turbo = readTurboJson();
  const entries = testTaskEntries(turbo);

  it('declares the generic test and test:integration tasks', () => {
    expect(entries.map(([name]) => name)).toEqual(expect.arrayContaining(TEST_TASKS));
  });

  // --only drops the dependency tasks from the hash; the context file is what puts them back. A
  // package-specific entry REPLACES the generic one, so each must list it itself.
  it('lists the context file and depends on ^build in every test task', () => {
    for (const [name, task] of entries) {
      expect(task.inputs, `${name} inputs`).toContain(CONTEXT_FILE);
      expect(task.inputs, `${name} inputs`).toContain('$TURBO_DEFAULT$');
      expect(task.dependsOn, `${name} dependsOn`).toContain('^build');
    }
  });

  it('keeps each test:integration override equal to its test override', () => {
    for (const [name, task] of entries.filter(([key]) => key.endsWith('#test:integration'))) {
      const unit = turbo.tasks[name.replace(/:integration$/, '')];
      expect(unit, `${name} has no matching #test entry`).toBeDefined();
      expect(task, name).toEqual(unit);
    }
  });

  it('names only real packages in the whole-repo list', () => {
    const names = new Set(workspacePackages().map(({ manifest }) => manifest.name));
    for (const name of WHOLE_REPO_TEST_PACKAGES) expect(names.has(name), name).toBe(true);
  });
});

// The reads that make a cached pass a lie. A package whose tests `git grep` the repo can only be
// keyed on the whole tree; a `..` literal that leaves the package needs an input covering it.
describe('test reads outside the package', () => {
  const turbo = readTurboJson();
  const packages = workspacePackages().map(pkg => ({ ...pkg, files: testFiles(pkg.dir) }));

  it('finds the test files it scans', () => {
    expect(packages.length).toBeGreaterThan(10);
    expect(packages.flatMap(pkg => pkg.files).length).toBeGreaterThan(100);
  });

  it.each(packages.map(pkg => [pkg.manifest.name, pkg]))(
    '%s: git scans run uncached or are keyed on the whole repo',
    (name, pkg) => {
      if (WHOLE_REPO_TEST_PACKAGES.includes(name)) return;
      const scanning = pkg.files.filter(
        file => !REPO_LANE_FILE.test(file) && GIT_SCAN.test(fs.readFileSync(path.join(repoRoot, file), 'utf8'))
      );
      expect(
        scanning,
        `${name}: these tests scan the repo with git; rename them *.repo.test.* (and give the package a test:repo script), or add the package to WHOLE_REPO_TEST_PACKAGES`
      ).toEqual([]);
    }
  );

  it.each(packages.map(pkg => [pkg.manifest.name, pkg]))('%s: repo-lane files have a lane to run in', (name, pkg) => {
    const repoLane = pkg.files.filter(file => REPO_LANE_FILE.test(file));
    if (repoLane.length === 0) return;
    expect(
      pkg.manifest.scripts?.['test:repo'],
      `${name} has ${repoLane.join(', ')} but no test:repo script`
    ).toBeDefined();
  });

  it('runs every test:repo script in CI', () => {
    const workflow = fs.readFileSync(path.join(repoRoot, '.github/workflows/ci.yml'), 'utf8');
    expect(workflow).toContain('pnpm --recursive --if-present run test:repo');
  });

  it.each(packages.map(pkg => [pkg.manifest.name, pkg]))(
    '%s: every path outside the package is hashed',
    (name, pkg) => {
      if (WHOLE_REPO_TEST_PACKAGES.includes(name)) return;
      const inputs = [
        ...TEST_TASKS.flatMap(task => turbo.tasks[`${name}#${task}`]?.inputs ?? []),
        ...(turbo.globalDependencies ?? []).map(file => `$TURBO_ROOT$/${file}`),
        ...dependencySources(pkg.manifest, packages).map(glob => `$TURBO_ROOT$/${glob}`),
      ];
      const ownInputs = TEST_TASKS.flatMap(task => turbo.tasks[`${name}#${task}`]?.inputs ?? []);
      // A literal that resolves to the repo root itself is a base the test joins its real path onto
      // (`resolve(__dirname, '../../..')`); the joined path is not visible here, so accept it only
      // where the package's own entry already names files from the root.
      const rootCovered = ownInputs.some(glob => glob.startsWith('$TURBO_ROOT$/'));
      const cachedFiles = pkg.files.filter(file => !REPO_LANE_FILE.test(file));
      const uncovered = escapedPaths(pkg.dir, cachedFiles).filter(
        target => !(target === '.' ? rootCovered : inputCovers(pkg.dir, inputs, target))
      );
      expect(
        uncovered,
        `${name}: add these to its #test inputs in turbo.json, or the package to WHOLE_REPO_TEST_PACKAGES`
      ).toEqual([]);
    }
  );
});

describe('buildContexts', () => {
  const dryRun = {
    tasks: [
      {
        taskId: 'a#build',
        task: 'build',
        package: 'a',
        directory: 'packages/a',
        hash: 'h-a',
        command: 'tsdown',
        dependencies: [],
      },
      {
        taskId: 'b#build',
        task: 'build',
        package: 'b',
        directory: 'packages/b',
        hash: 'h-b',
        command: '<NONEXISTENT>',
        dependencies: [],
      },
      {
        taskId: 'c#test',
        task: 'test',
        package: 'c',
        directory: 'packages/c',
        hash: 'h-c',
        command: 'vitest run',
        dependencies: ['b#build', 'a#build'],
      },
      {
        taskId: 'd#test',
        task: 'test',
        package: 'd',
        directory: 'packages/d',
        hash: 'h-d',
        command: '<NONEXISTENT>',
        dependencies: [],
      },
      {
        taskId: '@bike4mind/scripts#test',
        task: 'test',
        package: '@bike4mind/scripts',
        directory: 'packages/scripts',
        hash: 'h-e',
        command: 'vitest run',
        dependencies: [],
      },
    ],
  };
  const options = {
    env: { TZ: 'UTC', MONGOMS_VERSION: '7', HOME: '/root' },
    runtime: 'node=v24 platform=linux-x64',
    repoTree: 'tree1',
  };

  it('writes the sorted dependency hashes, runtime and test env for each package with the script', () => {
    const contexts = buildContexts(dryRun, 'test', options);
    expect([...contexts.keys()]).toEqual(['packages/c', 'packages/scripts']);
    const body = contexts.get('packages/c');
    expect(body).toContain('runtime node=v24 platform=linux-x64\n');
    expect(body).toContain('env MONGOMS_VERSION=7\nenv TZ=UTC\n');
    expect(body).not.toContain('HOME');
    expect(body).toContain('dep a#build h-a\ndep b#build h-b\n');
    expect(body).not.toContain('repo-tree');
  });

  it('keys whole-repo packages on the tree', () => {
    expect(buildContexts(dryRun, 'test', options).get('packages/scripts')).toContain('repo-tree tree1\n');
    expect(() => buildContexts(dryRun, 'test', { ...options, repoTree: '' })).toThrow(/repo tree/);
  });

  it('changes when a dependency hash changes', () => {
    const changed = JSON.parse(JSON.stringify(dryRun));
    changed.tasks[0].hash = 'h-a2';
    expect(buildContexts(changed, 'test', options).get('packages/c')).not.toBe(
      buildContexts(dryRun, 'test', options).get('packages/c')
    );
  });

  it('fails loudly on a dependency the dry run did not hash', () => {
    const broken = JSON.parse(JSON.stringify(dryRun));
    broken.tasks[2].dependencies.push('zz#build');
    expect(() => buildContexts(broken, 'test', options)).toThrow(/zz#build/);
  });
});

describe('run report and prune', () => {
  const summary = {
    tasks: [
      { taskId: 'b#test', hash: 'bbb', command: 'vitest run', cache: { status: 'MISS' }, execution: { exitCode: 1 } },
      { taskId: 'a#test', hash: 'aaa', command: 'vitest run', cache: { status: 'HIT' }, execution: { exitCode: 0 } },
      { taskId: 'n#test', hash: 'nnn', command: '<NONEXISTENT>', cache: { status: 'MISS' } },
    ],
  };

  it('lists skipped and run packages', () => {
    const rows = summarizeRun(summary);
    expect(rows.map(row => [row.taskId, row.skipped])).toEqual([
      ['a#test', true],
      ['b#test', false],
    ]);
    const report = formatReport(rows);
    expect(report).toContain('1 of 2 package task(s) skipped');
    expect(report).toContain('skipped  a#test  aaa');
    expect(report).toContain('ran      b#test  bbb  (exit 1)');
  });

  it('prunes only entries no run used', () => {
    const files = ['aaa.tar.zst', 'aaa-meta.json', 'aaa-manifest.json', 'ccc.tar.zst', 'ccc-meta.json', 'README'];
    expect(staleCacheEntries(files, ['aaa', 'bbb'])).toEqual(['ccc.tar.zst', 'ccc-meta.json']);
  });
});

// The legs run turbo, not pnpm, and must hand it the context and the shard args the right way.
describe('ci.yml test-shards turbo commands', () => {
  const ci = fs.readFileSync(path.join(repoRoot, '.github/workflows/ci.yml'), 'utf8');
  const turboLines = ci.split('\n').filter(line => /^\s*pnpm exec turbo run "\$SHARD_SCRIPT"/.test(line));

  it('runs both lanes through turbo with --only, after writing the context', () => {
    expect(turboLines, 'turbo test commands not found - has the step moved?').toHaveLength(2);
    for (const line of turboLines) expect(line).toMatch(/\s--only\s/);
    const contextCalls =
      ci.match(/^\s*node scripts\/turbo-test-cache\.mjs context "\$SHARD_SCRIPT" "\$\{filter_args\[@\]\}"$/gm) ?? [];
    expect(contextCalls).toHaveLength(2);
  });

  it('saves the cache only from trusted events', () => {
    const save = ci.slice(ci.indexOf('- name: Prune turbo test cache'), ci.indexOf('- name: Save turbo test cache'));
    expect(save).toMatch(/github\.event_name == 'push' \|\| github\.event_name == 'merge_group'/);
    expect(ci.match(/actions\/cache\/save@/g)).toHaveLength(1);
  });
});
