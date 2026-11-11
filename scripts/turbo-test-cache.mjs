#!/usr/bin/env node

// CI glue for the cached test lanes in .github/workflows/ci.yml (the `test-shards` job).
//
//   node scripts/turbo-test-cache.mjs context <task> <turbo filter args...>
//     The legs run `turbo run <task> --only`: the full graph would also execute every
//     dependency's `build`, which CI never runs there (core dist arrives as the core-build
//     artifact). But --only also drops those dependency tasks from the hash, so an edit to
//     b4m-core/common would replay a cached pass for every package that imports it. This
//     writes, per package, `.turbo/test-context` (an explicit input of every test task in
//     turbo.json, pinned by scripts/__tests__/turbo-test-cache.test.mjs) holding what --only
//     cannot see: the full-graph hash of each task the test depends on, the Node version and
//     platform, and
//     the env that changes how a suite runs; for WHOLE_REPO_TEST_PACKAGES, the git tree too.
//
//   node scripts/turbo-test-cache.mjs report <runs dir>
//     Lists every package of the newest `--summarize` run as run or skipped (cache hit), in the
//     log and in the job summary, so a skipped package is visible to a reviewer.
//
//   node scripts/turbo-test-cache.mjs prune <runs dir> <cache dir>
//     Drops cache entries no run of this job used, so the saved cache holds the leg's current
//     state instead of growing with every save.

import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const CONTEXT_FILE = '.turbo/test-context';

// Env that changes how a suite runs but that turbo does not hash for a test task. `CI` is
// already a globalEnv in turbo.json. Matched by name or by prefix (trailing `*`).
export const CONTEXT_ENV = ['TZ', 'TMPDIR', 'NODE_OPTIONS', 'VITEST_MAX_WORKERS', 'MONGOMS_*'];

// Packages whose suites read the repo far outside their own directory: `git grep` or
// `git ls-files` over every tracked .ts file, or walks of apps/, b4m-core/, infra/, .github/ and
// root config. No input glob list stays honest for those, so their context carries the whole
// tracked tree: they re-run on every new commit and hit only on a re-run of the same commit (a
// flaky queue entry). A package lands here when the guard in
// scripts/__tests__/turbo-test-cache.test.mjs finds such a read in its tests. The cheaper way out
// is to name those tests `*.repo.test.*` and run them from a `test:repo` script, which CI runs
// uncached ("Run repo-scan tests" in ci.yml); apps/client does that.
export const WHOLE_REPO_TEST_PACKAGES = [
  '@bike4mind/database',
  '@bike4mind/infra',
  '@bike4mind/resource',
  '@bike4mind/scripts',
  '@bike4mind/server-utils',
  '@bike4mind/services',
  '@bike4mind/workers',
];

const NO_SCRIPT = '<NONEXISTENT>';

/**
 * Builds the context file body for every package that defines `taskName`, from a full-graph
 * `turbo run --dry=json`. Returns Map<package directory, file body>.
 */
export function buildContexts(dryRun, taskName, { env, runtime, repoTree }) {
  const hashByTaskId = new Map(dryRun.tasks.map(task => [task.taskId, task.hash]));
  const envLines = Object.keys(env)
    .filter(name =>
      CONTEXT_ENV.some(pattern => (pattern.endsWith('*') ? name.startsWith(pattern.slice(0, -1)) : name === pattern))
    )
    .sort()
    .map(name => `env ${name}=${env[name]}`);

  const contexts = new Map();
  for (const task of dryRun.tasks) {
    if (task.task !== taskName || task.command === NO_SCRIPT) continue;
    const depLines = [...task.dependencies].sort().map(taskId => {
      const hash = hashByTaskId.get(taskId);
      // A dependency the dry run did not hash would silently drop out of the key. Fail loudly.
      if (!hash) throw new Error(`${task.taskId}: no hash for dependency ${taskId} in the dry run`);
      return `dep ${taskId} ${hash}`;
    });
    const wholeRepo = WHOLE_REPO_TEST_PACKAGES.includes(task.package);
    if (wholeRepo && !repoTree) throw new Error(`${task.taskId}: whole-repo package but no repo tree hash`);
    const body = [
      '# Written by scripts/turbo-test-cache.mjs; an input of the test tasks in turbo.json.',
      `runtime ${runtime}`,
      ...(wholeRepo ? [`repo-tree ${repoTree}`] : []),
      ...envLines,
      ...depLines,
      '',
    ].join('\n');
    contexts.set(task.directory, body);
  }
  return contexts;
}

/** One row per task in a `turbo run --summarize` file, skipped (cache hit) or run. */
export function summarizeRun(runSummary) {
  return runSummary.tasks
    .filter(task => task.command !== NO_SCRIPT)
    .map(task => ({
      taskId: task.taskId,
      hash: task.hash,
      skipped: task.cache?.status === 'HIT',
      exitCode: task.execution?.exitCode ?? null,
    }))
    .sort((a, b) => a.taskId.localeCompare(b.taskId));
}

/** Cache dir entries (`<hash>.tar.zst`, `<hash>-meta.json`, ...) whose hash this run did not use. */
export function staleCacheEntries(fileNames, keepHashes) {
  const keep = new Set(keepHashes);
  return fileNames.filter(name => {
    const hash = /^([0-9a-f]+)[.-]/.exec(name)?.[1];
    return hash !== undefined && !keep.has(hash);
  });
}

export function formatReport(rows) {
  const skipped = rows.filter(row => row.skipped);
  const ran = rows.filter(row => !row.skipped);
  const lines = [
    `Turbo test cache: ${skipped.length} of ${rows.length} package task(s) skipped (inputs unchanged since a cached pass).`,
    ...skipped.map(row => `  skipped  ${row.taskId}  ${row.hash}`),
    ...ran.map(row => `  ran      ${row.taskId}  ${row.hash}${row.exitCode ? `  (exit ${row.exitCode})` : ''}`),
  ];
  return lines.join('\n');
}

function runContext(taskName, filterArgs) {
  if (!taskName || filterArgs.length === 0) throw new Error('usage: context <task> <turbo filter args...>');
  const stdout = execFileSync('pnpm', ['exec', 'turbo', 'run', taskName, ...filterArgs, '--dry=json'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const contexts = buildContexts(JSON.parse(stdout), taskName, {
    env: process.env,
    runtime: `node=${process.version} platform=${process.platform}-${process.arch}`,
    repoTree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: repoRoot, encoding: 'utf8' }).trim(),
  });
  if (contexts.size === 0) throw new Error(`no package in the filter set defines a "${taskName}" script`);
  for (const [directory, body] of contexts) {
    const file = join(repoRoot, directory, CONTEXT_FILE);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, body);
  }
  console.log(`Wrote ${CONTEXT_FILE} for ${contexts.size} package(s): ${[...contexts.keys()].join(' ')}`);
}

function readRunSummaries(runsDir) {
  return readdirSync(runsDir)
    .filter(name => name.endsWith('.json'))
    .map(name => join(runsDir, name))
    .sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs)
    .map(file => JSON.parse(readFileSync(file, 'utf8')));
}

function runReport(runsDir) {
  if (!runsDir) throw new Error('usage: report <runs dir>');
  const latest = readRunSummaries(runsDir).at(-1);
  if (!latest) throw new Error(`no turbo run summary in ${runsDir}`);
  const report = formatReport(summarizeRun(latest));
  console.log(report);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n\`\`\`\n${report}\n\`\`\`\n`);
  }
}

function runPrune(runsDir, cacheDir) {
  if (!runsDir || !cacheDir) throw new Error('usage: prune <runs dir> <cache dir>');
  const used = readRunSummaries(runsDir).flatMap(summary => summarizeRun(summary).map(row => row.hash));
  const stale = staleCacheEntries(readdirSync(cacheDir), used);
  for (const name of stale) rmSync(join(cacheDir, name), { force: true });
  console.log(`Kept the cache entries of ${new Set(used).size} task run(s); pruned ${stale.length} file(s).`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, ...rest] = process.argv.slice(2);
  if (command === 'context') runContext(rest[0], rest.slice(1));
  else if (command === 'report') runReport(rest[0]);
  else if (command === 'prune') runPrune(rest[0], rest[1]);
  else {
    console.error(
      'usage: turbo-test-cache.mjs context <task> <filters...> | report <runs dir> | prune <runs dir> <cache dir>'
    );
    process.exit(2);
  }
}
