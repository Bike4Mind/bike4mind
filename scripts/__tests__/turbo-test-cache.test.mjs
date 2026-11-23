import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
const ISOLATED_DIRS = [
  'packages/database',
  'b4m-core/infra',
  'b4m-core/resource',
  'packages/scripts',
  'packages/server-utils',
  'b4m-core/services',
  'apps/workers',
];

// turbo.json is JSONC; every comment in it is a whole line.
function readTurboJson() {
  const text = fs.readFileSync(path.join(repoRoot, 'turbo.json'), 'utf8');
  return JSON.parse(text.replace(/^\s*\/\/.*$/gm, ''));
}

function testTaskEntries(turbo) {
  return Object.entries(turbo.tasks).filter(([name]) => TEST_TASKS.includes(name.split('#').at(-1)));
}

function allWorkspacePackages() {
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
    }));
}

function workspacePackages() {
  return allWorkspacePackages().filter(({ manifest }) => TEST_TASKS.some(task => manifest.scripts?.[task]));
}

function trackedFiles(dir) {
  return execFileSync('git', ['ls-files', dir], { cwd: repoRoot, encoding: 'utf8' }).split('\n').filter(Boolean);
}

function testFiles(dir) {
  return trackedFiles(dir)
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
// Computed joins cannot be inferred safely; changes need a fresh input audit or an uncached lane.
const AUDITED_ROOT_READERS = {
  'apps/workers/src/cli/tools.wiring.test.ts': 'fe20c678c7cc82e50e8819ee8633667090eaea5144d4250bab803c242afdccb2',
  'apps/workers/src/database/migratorInvocation.wiring.test.ts':
    '112b67a3ee6a239d7644d71a074791ea19ac8cc32cf9b44dba1aee70a9a86455',
  'b4m-core/infra/src/__tests__/bucketRouteCollision.test.ts':
    '7de59edfa8480f593b890d222078b24809bc6d47a5d2356be68c8ff121edc661',
  'b4m-core/infra/src/__tests__/changelogGithubRetry.test.ts':
    'e71168a74ce0b031e6ab5f4959bd26f904d6dde4d1bc0f3e07fcf5765675e1ac',
  'b4m-core/resource/src/index.test.ts': '9c39bb47b367afedcc09d29b232392f9da5581e99058c20b9592bd779e2f99a1',
  'b4m-core/resource/src/selfHostAppUrl.test.ts': '2ce51bb6b3f7990e92bc95adc15db1619dac25456f11182d2a18562b53a15890',
  'b4m-core/resource/src/selfHostQueueParity.test.ts':
    'e3cf442449fad5938b53d5d5dd225d6a11b48d1ca59f569582ad81536e1fc027',
  'packages/server-utils/src/utils/ip.wiring.test.ts':
    'f2a34abcea1d1b8479363aaea456e3ff704ff465aa71ed95dc213449eb187b6c',
  'packages/server-utils/src/utils/textEditBackupPrefix.test.ts':
    '1bce847a1c64cc66ddc430ad1fc5bd2a6945f423d3fee54cc6702bd939597a10',
};

function literalTargets(file, literal, source, exists = fs.existsSync) {
  const bases = [path.dirname(file)];
  if (/(?:resolve|join)\(\s*fileURLToPath\(import\.meta\.url\)\s*,/.test(source)) bases.push(file);
  return bases.flatMap(base => {
    const target = path.resolve(repoRoot, base, literal);
    return [target, `${target}.ts`, path.join(target, 'index.ts')]
      .filter(candidate => exists(candidate))
      .map(candidate => path.relative(repoRoot, candidate))
      .filter(candidate => !candidate.startsWith('..'));
  });
}

function rootLiteralPaths(files) {
  const targets = new Set();
  for (const file of files) {
    const source = fs.readFileSync(path.join(repoRoot, file), 'utf8');
    if (!escapedPaths(path.dirname(file), [file]).includes('.')) continue;
    expect(
      createHash('sha256').update(source).digest('hex'),
      `${file}: re-audit computed root reads and their inputs`
    ).toBe(AUDITED_ROOT_READERS[file]);
    for (const [, literal] of source.matchAll(/['"`]([^'"`\s$]+)['"`]/g)) {
      if (literal.startsWith('.') && !literal.startsWith('.changeset/') && !literal.startsWith('.env.')) continue;
      if (path.isAbsolute(literal) || literal.includes('*')) continue;
      if (!literal.includes('/') && !literal.includes('.')) continue;
      if (fs.existsSync(path.join(repoRoot, literal))) targets.add(literal.replace(/\/$/, ''));
    }
  }
  return [...targets];
}

/** Repo-relative paths a package's test files name with a `..` literal that leaves the package. */
function escapedPaths(dir, files) {
  const escaped = new Set();
  for (const file of files) {
    const source = fs.readFileSync(path.join(repoRoot, file), 'utf8');
    for (const [, literal] of source.matchAll(CLIMBING_LITERAL)) {
      for (const target of literalTargets(file, literal, source)) {
        if (target !== dir && !target.startsWith(`${dir}/`)) escaped.add(target === '' ? '.' : target);
      }
    }
  }
  return [...escaped];
}

// A declared workspace dependency's build inputs are already in the hash through ^build. One
// with no build script contributes nothing there: see sourceOnlyDependencyReads.
function dependencySources(manifest, packages) {
  const dependencies = { ...manifest.dependencies, ...manifest.devDependencies, ...manifest.peerDependencies };
  const declared = new Set([
    ...Object.keys(dependencies),
    ...Object.values(dependencies).flatMap(value => /^workspace:(@[^/]+\/[^@]+)@/.exec(value)?.[1] ?? []),
  ]);
  return packages
    .filter(pkg => declared.has(pkg.manifest.name) && pkg.manifest.scripts?.build)
    .map(pkg => `${pkg.dir}/src/**`);
}

/** Tracked files a package's `exports` (or `main`) resolve to; `*` in a subpath target spans `/`. */
function entryFiles(pkg) {
  const targets = [];
  const collect = value => {
    if (typeof value === 'string') targets.push(value);
    else if (value && typeof value === 'object') Object.values(value).forEach(collect);
  };
  collect(pkg.manifest.exports ?? pkg.manifest.main);
  const patterns = targets.map(
    target =>
      new RegExp(
        `^${path.posix
          .join(pkg.dir, target)
          .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
          .replaceAll('*', '.*')}$`
      )
  );
  return trackedFiles(pkg.dir).filter(file => patterns.some(pattern => pattern.test(file)));
}

// A runtime dependency with no build script ships its source straight to the consumer, so ^build
// hashes none of it: its entry files, and the outside paths they name with a `..` literal (a
// helper-owned root such as loadHelpArticles' DOCS_ROOT), have to be in the consumer's own
// inputs. Entry files only, not what they import. devDependencies are skipped: the source-only
// ones are lint/tsconfig presets no test imports.
function sourceOnlyDependencyReads(manifest, allPackages) {
  const runtime = new Set(Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies }));
  return allPackages
    .filter(dep => runtime.has(dep.manifest.name) && !dep.manifest.scripts?.build)
    .flatMap(dep => {
      const files = entryFiles(dep);
      return [...files, ...escapedPaths(dep.dir, files)];
    });
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

describe('escaped path resolution', () => {
  it('keeps declared workspace aliases in the dependency build inputs', () => {
    expect(
      dependencySources({ dependencies: { '@example/alias': 'workspace:@example/core@*' } }, [
        { dir: 'packages/core', manifest: { name: '@example/core', scripts: { build: 'tsdown' } } },
      ])
    ).toEqual(['packages/core/src/**']);
  });

  it.each(['packages/database', 'b4m-core/infra', 'b4m-core/resource', 'b4m-core/services', 'packages/scripts'])(
    '%s preserves Vitest default excludes in the ordinary lane',
    dir => {
      const config = fs.readFileSync(path.join(repoRoot, dir, 'vitest.config.ts'), 'utf8');
      expect(config).toContain("import { configDefaults, defineConfig } from 'vitest/config'");
      expect(config).toContain("exclude: [...configDefaults.exclude, '**/*.repo.test.ts']");
    }
  );

  it.each([
    ['packages/scripts/migrate/migrations/example', 'packages/scripts/migrate/migrations/example.ts'],
    ['packages/scripts/migrate/migrations', 'packages/scripts/migrate/migrations/index.ts'],
  ])('resolves the extensionless import %s', (target, resolved) => {
    const file = 'apps/workers/src/queueHandlers/example.e2e.test.ts';
    const literal = path.relative(path.dirname(file), target);
    expect(literalTargets(file, literal, '', candidate => candidate === path.join(repoRoot, resolved))).toEqual([
      resolved,
    ]);
  });

  it('finds a root climb based on the file URL rather than its directory', () => {
    expect(
      escapedPaths('packages/server-utils', ['packages/server-utils/src/utils/textEditBackupPrefix.test.ts'])
    ).toContain('.');
    const reads = rootLiteralPaths(['packages/server-utils/src/utils/textEditBackupPrefix.test.ts']);
    const inputs = readTurboJson().tasks['@bike4mind/server-utils#test'].inputs;
    for (const target of [
      'infra/buckets.ts',
      'compose.selfhost.yaml',
      'selfhost/kubernetes/files/buckets.sh',
      'scripts/smoke_selfhost_objectstore.py',
    ]) {
      expect(reads).toContain(target);
      expect(inputCovers('packages/server-utils', inputs, target), target).toBe(true);
      expect(inputCovers('packages/server-utils', [], target), target).toBe(false);
    }
  });

  it('keeps paths above the repository out of the input inventory', () => {
    expect(literalTargets('packages/example/test.ts', '../../../../etc/passwd', '', () => true)).toEqual([]);
  });
});

describe('turbo.json test tasks', () => {
  const turbo = readTurboJson();
  const entries = testTaskEntries(turbo);

  it('declares the generic test and test:integration tasks', () => {
    expect(entries.map(([name]) => name)).toEqual(expect.arrayContaining(TEST_TASKS));
  });

  it('never caches repo scans, even when invoked through turbo', () => {
    expect(turbo.tasks['test:repo'].cache).toBe(false);
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
  const allPackages = allWorkspacePackages();
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

  it.each(ISOLATED_DIRS)(
    '%s: discovers every repo scan exactly once and outside cached lanes',
    dir => {
      const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, dir, 'package.json'), 'utf8'));
      expect(manifest.scripts['test:repo']).toBe('REPO_TEST_LANE=repo vitest run');
      const discover = lane => {
        const stdout = execFileSync('pnpm', ['exec', 'vitest', 'list', '--filesOnly', '--json'], {
          cwd: path.join(repoRoot, dir),
          env: {
            ...process.env,
            VITEST_MAX_WORKERS: '25%',
            REPO_TEST_LANE: lane === 'repo' ? 'repo' : '',
            WORKERS_TEST_LANE: lane,
            SERVER_UTILS_TEST_LANE: lane,
          },
          encoding: 'utf8',
          maxBuffer: 20 * 1024 * 1024,
        });
        return JSON.parse(stdout.slice(stdout.indexOf('['))).map(file =>
          path.relative(repoRoot, path.resolve(repoRoot, dir, file.file))
        );
      };
      const expected = testFiles(dir)
        .filter(file => REPO_LANE_FILE.test(file))
        .sort();
      expect(expected.length).toBeGreaterThan(0);
      expect(discover('repo').sort()).toEqual(expected);
      expect(discover('unit').filter(file => REPO_LANE_FILE.test(file))).toEqual([]);
      if (['apps/workers', 'packages/server-utils'].includes(dir)) {
        expect(discover('integration').filter(file => REPO_LANE_FILE.test(file))).toEqual([]);
      }
    },
    30000
  );

  // Line-anchored, so a commented-out step, a disabled `if:` or the command left in a comment
  // all fail here instead of the repo lane silently running nowhere.
  it('runs every test:repo script in CI, once, on the misc leg', () => {
    const workflow = fs.readFileSync(path.join(repoRoot, '.github/workflows/ci.yml'), 'utf8');
    const lines = workflow.split('\n');
    const start = lines.findIndex(line => /^\s*- name: Run repo-scan tests\s*$/.test(line));
    expect(start, 'the "Run repo-scan tests" step is missing from ci.yml').toBeGreaterThan(-1);
    const indent = lines[start].indexOf('-');
    const end = lines.findIndex(
      (line, index) =>
        index > start && line.trim() !== '' && line.search(/\S/) <= indent && !line.trim().startsWith('#')
    );
    const step = lines.slice(start + 1, end === -1 ? undefined : end).filter(line => !line.trim().startsWith('#'));
    expect(step).toContainEqual(
      expect.stringMatching(/^\s*run: pnpm --recursive --if-present --workspace-concurrency=1 run test:repo\s*$/)
    );
    const condition = step.find(line => /^\s*if:/.test(line));
    expect(condition, 'the step needs an if: pinning it to one leg').toBeDefined();
    expect(condition).toContain("matrix.shard.name == 'misc'");
    expect(condition).not.toMatch(/\bfalse\b/);
    expect(workflow).toMatch(/^\s*- name: misc\s*$/m);
  });

  it.each(packages.map(pkg => [pkg.manifest.name, pkg]))(
    '%s: every path outside the package is hashed',
    (name, pkg) => {
      if (WHOLE_REPO_TEST_PACKAGES.includes(name)) return;
      const inputs = [
        ...TEST_TASKS.flatMap(task => turbo.tasks[`${name}#${task}`]?.inputs ?? []),
        ...(turbo.globalDependencies ?? []).map(file => `$TURBO_ROOT$/${file}`),
        ...dependencySources(pkg.manifest, allPackages).map(glob => `$TURBO_ROOT$/${glob}`),
      ];
      const ownInputs = TEST_TASKS.flatMap(task => turbo.tasks[`${name}#${task}`]?.inputs ?? []);
      // A literal that resolves to the repo root itself is a base the test joins its real path onto
      // (`resolve(__dirname, '../../..')`); the joined path is not visible here, so accept it only
      // where the package's own entry already names files from the root.
      const rootCovered = ownInputs.some(glob => glob.startsWith('$TURBO_ROOT$/'));
      const cachedFiles = pkg.files.filter(file => !REPO_LANE_FILE.test(file));
      const rootReads = ISOLATED_DIRS.includes(pkg.dir) ? rootLiteralPaths(cachedFiles) : [];
      const reads = [
        ...escapedPaths(pkg.dir, cachedFiles),
        ...rootReads,
        ...sourceOnlyDependencyReads(pkg.manifest, allPackages),
      ];
      const uncovered = [...new Set(reads)].filter(
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
    expect(save).toMatch(/if: \$\{\{ !cancelled\(\) && github\.event_name == 'push' && /);
    expect(ci.match(/actions\/cache\/save@/g)).toHaveLength(1);
  });
});
