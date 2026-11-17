#!/usr/bin/env node

// The local "verify before pushing" loop: typecheck (tsgo with tsc fallback, the same
// `typecheck:fast` CI gates on), test and lint only what this branch changed against
// $TURBO_SCM_BASE (default origin/main). CI still runs everything; this only decides what a
// local run can skip.
//
//   node scripts/verify-affected.mjs [--tasks typecheck:fast,test] [--no-lint] [--dry] [turbo args...]
//
// Package selection is turbo's own `...[<merge-base>]` filter (changed packages plus their
// dependents) widened by the cross-package inputs in turbo.json: @bike4mind/workers typechecks
// apps/client source, server-utils tests read apps/client/pages, and so on. Neither --affected
// nor a [ref] filter follows those edges, so a client-only change would skip workers. Unknown
// arguments go to turbo (e.g. --concurrency=4).

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, matchesGlob, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const DEFAULT_TASKS = ['typecheck:fast', 'test'];

// A change to any of these can move every package's result, so they run the full graph.
const FULL_RUN_FILES = ['turbo.json', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.json'];

// Lint config: a change here can flip the verdict for files this branch never touched.
const FULL_LINT_GLOBS = [
  'eslint.config.mjs',
  'eslint-suppressions.json',
  'eslint-rules/**',
  'packages/eslint-config/**',
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

export function planLint(changedFiles, fileExists) {
  if (changedFiles.some(file => FULL_LINT_GLOBS.some(glob => matchesGlob(file, glob)))) return { mode: 'full' };
  const files = changedFiles.filter(file => LINTABLE.test(file) && fileExists(file));
  return files.length ? { mode: 'files', files } : { mode: 'skip' };
}

export function parseArgs(argv) {
  const options = { tasks: DEFAULT_TASKS, lint: true, dry: false, turboArgs: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--tasks') options.tasks = argv[++i].split(',').filter(Boolean);
    else if (arg.startsWith('--tasks=')) options.tasks = arg.slice('--tasks='.length).split(',').filter(Boolean);
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
  // Deleted files count: removing a client file can break the workers typecheck.
  const tracked = git(['diff', '--name-only', mergeBase]);
  const untracked = git(['ls-files', '--others', '--exclude-standard']);
  return [...new Set([...tracked, ...untracked])];
}

function readPackageDirs() {
  const out = execFileSync('pnpm', ['exec', 'turbo', 'ls', '--output=json'], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const { packages } = JSON.parse(out.slice(out.indexOf('{')));
  return Object.fromEntries(packages.items.map(({ name, path }) => [name, path]));
}

function run(command, args, dry) {
  console.log(`\n$ ${[command, ...args].join(' ')}`);
  if (dry) return;
  const { status, error } = spawnSync(command, args, { cwd: repoRoot, stdio: 'inherit' });
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
      const extra = packagesReachedByForeignInputs({
        turbo,
        packageDirs: readPackageDirs(),
        tasks: options.tasks,
        changedFiles,
      });
      // No `...` on the extra packages: only their own task reads the changed file, not their dependents.
      filters.push(`--filter=...[${mergeBase}]`, ...[...extra].map(name => `--filter=${name}`));
      if (extra.size) console.log(`verify: also running ${[...extra].join(', ')} (cross-package inputs in turbo.json)`);
    }
    run('pnpm', ['exec', 'turbo', 'run', ...options.tasks, ...filters, ...options.turboArgs], options.dry);
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
