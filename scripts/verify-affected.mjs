#!/usr/bin/env node

// The local "verify before pushing" loop: typecheck (tsgo, the same
// `typecheck` CI gates on), test and lint only what this branch changed against
// $TURBO_SCM_BASE (default origin/main). CI's test-shards job makes the same selection for a PR
// (scripts/ci-affected-tests.mjs, through selectAffected below).
//
//   node scripts/verify-affected.mjs [--tasks typecheck,test] [--no-lint] [--dry] [turbo args...]
//
// Package selection is the packages owning a changed file plus their dependents, widened by the
// cross-package inputs in turbo.json: @bike4mind/workers typechecks apps/client source,
// server-utils tests read apps/client/pages, and so on. Neither --affected nor a [ref] filter
// follows those edges, so a client-only change would skip workers. Unknown arguments go to turbo
// (e.g. --concurrency=4).

import { execFileSync, spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, matchesGlob, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const DEFAULT_TASKS = ['typecheck', 'test'];

// A change to any of these can move every package's result, so they run the full graph.
const FULL_RUN_FILES = ['turbo.json', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.json'];

// A change here can flip the verdict for files this branch never touched: the lint config, or a
// root manifest/lockfile change that moves an eslint plugin or typescript-eslint version.
const FULL_LINT_GLOBS = [
  'package.json',
  'pnpm-lock.yaml',
  'eslint.config.mjs',
  'eslint-suppressions.json',
  'eslint-rules/**',
];

const LINTABLE = /\.(?:[cm]?js|jsx|[cm]?ts|tsx)$/;

// turbo.json is JSONC; every comment in it is a whole line (pinned by turbo-test-cache.test.mjs).
export function readTurboJson(root = repoRoot) {
  const text = readFileSync(join(root, 'turbo.json'), 'utf8');
  return JSON.parse(text.replace(/^\s*\/\/.*$/gm, ''));
}

// Resolves a task input to a repo-relative glob when it points outside the package's own
// directory. Inputs inside the package are already covered by turbo's [ref] filter.
export function resolveForeignInput(input, packageDir) {
  if (input.startsWith('!') || input.startsWith('$TURBO_DEFAULT$')) return null;
  if (input.startsWith('$TURBO_ROOT$/')) return input.slice('$TURBO_ROOT$/'.length);
  if (!input.startsWith('../')) return null;
  return posix.normalize(posix.join(packageDir, input));
}

// Packages whose `<pkg>#<task>` inputs reach a changed file outside the package.
export function packagesReachedByForeignInputs({ turbo, packageDirs, tasks, changedFiles }) {
  const reached = new Set();
  for (const [key, config] of Object.entries(turbo.tasks)) {
    const [name, task] = key.split('#');
    if (!task || !tasks.includes(task)) continue;
    const packageDir = packageDirs[name];
    if (!packageDir) continue;
    const globs = (config.inputs ?? []).map(input => resolveForeignInput(input, packageDir)).filter(Boolean);
    if (changedFiles.some(file => globs.some(glob => matchesGlob(file, glob)))) reached.add(name);
  }
  return reached;
}

export function needsFullRun(changedFiles, turbo) {
  const globals = turbo.globalDependencies ?? [];
  return changedFiles.some(file => FULL_RUN_FILES.includes(file) || globals.some(glob => matchesGlob(file, glob)));
}

// The workspace package owning a repo-relative path: the deepest package directory containing it.
export function packageOfFile(file, packageDirs) {
  let owner = null;
  let ownerDepth = -1;
  for (const [name, dir] of Object.entries(packageDirs)) {
    if (file.startsWith(`${dir}/`) && dir.length > ownerDepth) {
      owner = name;
      ownerDepth = dir.length;
    }
  }
  return owner;
}

// `changed` run with their dependents, `extra` (reached only through a foreign input) without.
export function selectAffected({ changedFiles, turbo, packageDirs, tasks }) {
  if (needsFullRun(changedFiles, turbo)) return { full: true };
  const owners = changedFiles.map(file => packageOfFile(file, packageDirs));
  const changed = new Set(owners.filter(Boolean));
  const reached = packagesReachedByForeignInputs({ turbo, packageDirs, tasks, changedFiles });
  return {
    full: false,
    changed: [...changed].sort(),
    extra: [...reached].filter(name => !changed.has(name)).sort(),
    // A file outside every package belongs to the root package, as in turbo's [ref] filter, so a
    // root task such as //#typecheck still runs.
    root: owners.includes(null),
  };
}

export function turboFilters({ changed, extra, root = false }) {
  return [
    ...changed.map(name => `--filter=...${name}`),
    ...extra.map(name => `--filter=${name}`),
    ...(root ? ['--filter=//'] : []),
  ];
}

export function planLint(changedFiles, fileExists) {
  if (changedFiles.some(file => FULL_LINT_GLOBS.some(glob => matchesGlob(file, glob)))) return { mode: 'full' };
  const files = changedFiles.filter(file => LINTABLE.test(file) && fileExists(file));
  return files.length ? { mode: 'files', files } : { mode: 'skip' };
}

export function parseArgs(argv) {
  const options = { tasks: DEFAULT_TASKS, lint: true, dry: false, turboArgs: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--tasks') {
      if (i + 1 >= argv.length) throw new Error('verify: --tasks needs a value, e.g. --tasks typecheck,test');
      options.tasks = argv[++i].split(',').filter(Boolean);
    } else if (arg.startsWith('--tasks=')) options.tasks = arg.slice('--tasks='.length).split(',').filter(Boolean);
    else if (arg === '--no-lint') options.lint = false;
    else if (arg === '--dry') options.dry = true;
    else options.turboArgs.push(arg);
  }
  return options;
}

function git(args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).split('\n').filter(Boolean);
}

function changedFilesSince(mergeBase) {
  // Deleted files count: removing a client file can break the workers typecheck. --no-renames
  // keeps the old path of a move, which rename detection would otherwise drop.
  const tracked = git(['diff', '--no-renames', '--name-only', mergeBase]);
  const untracked = git(['ls-files', '--others', '--exclude-standard']);
  return [...new Set([...tracked, ...untracked])];
}

// Name -> directory of the workspace packages `turbo ls` resolves for these filters (all when none).
export function readPackageDirs(filters = []) {
  let out;
  try {
    out = execFileSync('pnpm', ['exec', 'turbo', 'ls', ...filters, '--output=json'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const reason = String(error.stderr ?? '').trim() || error.message;
    throw new Error(`\`turbo ls\` failed (is \`pnpm install\` done?)\n${reason}`);
  }
  const { packages } = JSON.parse(out.slice(out.indexOf('{')));
  return Object.fromEntries(packages.items.map(({ name, path }) => [name, path]));
}

// Worktrees on one machine share a content-addressed turbo cache; a per-worktree one rebuilds every
// upstream package in each fresh worktree. An explicit TURBO_CACHE_DIR wins.
function turboEnv() {
  return { ...process.env, TURBO_CACHE_DIR: process.env.TURBO_CACHE_DIR || join(homedir(), '.cache', 'turbo-b4m') };
}

// Turbo's default is 10 concurrent multi-threaded tasks, which oversubscribes the host when several
// sessions push at once. TURBO_CONCURRENCY is this script's own override, not a turbo variable.
function concurrencyArgs(turboArgs) {
  if (turboArgs.some(arg => arg === '--concurrency' || arg.startsWith('--concurrency='))) return [];
  return [`--concurrency=${process.env.TURBO_CONCURRENCY || '25%'}`];
}

function run(command, args, dry) {
  console.log(`\n$ ${[command, ...args].join(' ')}`);
  if (dry) return;
  const { status, error } = spawnSync(command, args, { cwd: repoRoot, stdio: 'inherit', env: turboEnv() });
  if (error) throw error;
  if (status !== 0) process.exit(status ?? 1);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const base = process.env.TURBO_SCM_BASE || 'origin/main';

  let mergeBase;
  try {
    [mergeBase] = git(['merge-base', base, 'HEAD']);
  } catch {
    console.warn(`verify: no merge-base with ${base}; running the full graph and full lint.`);
  }

  const changedFiles = mergeBase ? changedFilesSince(mergeBase) : [];
  const turbo = readTurboJson();
  const fullRun = !mergeBase || needsFullRun(changedFiles, turbo);

  if (options.tasks.length) {
    const filters = [];
    if (!fullRun) {
      let packageDirs;
      try {
        packageDirs = readPackageDirs();
      } catch (error) {
        console.error(`verify: ${error.message}`);
        process.exit(1);
      }
      const selection = selectAffected({ changedFiles, turbo, packageDirs, tasks: options.tasks });
      filters.push(...turboFilters(selection));
      if (selection.extra.length) {
        console.log(`verify: also running ${selection.extra.join(', ')} (cross-package inputs in turbo.json)`);
      }
    }
    if (fullRun || filters.length) {
      run('pnpm', ['exec', 'turbo', 'run', ...options.tasks, ...filters, ...concurrencyArgs(options.turboArgs), ...options.turboArgs], options.dry);
    } else {
      console.log('\nverify: no workspace package changed; skipping turbo.');
    }
    if (options.tasks.some(task => task.startsWith('typecheck'))) {
      run('pnpm', ['run', 'typecheck:infra:local'], options.dry);
    }
  }

  if (!options.lint) return;
  const lint = mergeBase ? planLint(changedFiles, file => existsSync(join(repoRoot, file))) : { mode: 'full' };
  if (lint.mode === 'skip') console.log('\nverify: no lintable files changed; skipping lint.');
  else if (lint.mode === 'full') run('pnpm', ['run', 'lint:check'], options.dry);
  else run('pnpm', ['run', 'lint:check:files', '--no-warn-ignored', ...lint.files], options.dry);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
