#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLIENT = 'apps/client/';
const SOURCE = /\.[cm]?[jt]sx?$/;
const TEST = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const BACKSTOP = /(?:^|\/)(?:vitest[^/]*|vite\.config[^/]*|tsconfig[^/]*|package\.json|__mocks__|mocks?|fixtures?|__fixtures__|test-utils?|testUtils|testHelpers)(?:\/|$)|(?:setup|\.config\.)/i;

export function planClientRelated(changedFiles, relatedSafe = true) {
  if (!relatedSafe || !Array.isArray(changedFiles) || !changedFiles.length) return { mode: 'full' };
  if (changedFiles.some(file => typeof file !== 'string' || !file.startsWith(CLIENT) || !SOURCE.test(file) || BACKSTOP.test(file))) {
    return { mode: 'full' };
  }
  if (changedFiles.some(file => file.includes('\\') || file.split('/').includes('..') || /[\0\r\n]/.test(file))) {
    return { mode: 'full' };
  }
  return { mode: 'related', files: [...new Set(changedFiles)].sort() };
}

export function parseDiff(text) {
  const tokens = text.split('\0');
  if (tokens.pop() !== '') throw new Error('unterminated git diff');
  const files = [];
  let relatedSafe = true;
  for (let i = 0; i < tokens.length; i += 2) {
    const status = tokens[i];
    const file = tokens[i + 1];
    if (!/^[AMDTUXB]$/.test(status) || !file) throw new Error('unknown git diff status');
    files.push(file);
    if (!['A', 'M'].includes(status)) relatedSafe = false;
  }
  return { files: [...new Set(files)].sort(), relatedSafe };
}

// Workspace helpers can hide reads behind built dist entrypoints, outside Vite's source graph.
export function isUntraceableReader(source) {
  return /['"`]@bike4mind\/|['"`](?:node:)?(?:fs(?:\/promises)?|child_process|module|glob|fast-glob|globby|fs-extra)['"`]|\b(?:require|import)\s*\(|import\.meta\.(?:glob|resolve)|\b(?:readFile|readFileSync|readdir|readdirSync|readJson|readJSON|createRequire)\b/.test(source);
}

export function conservativeSeeds(files, readSource) {
  return files.filter(file => SOURCE.test(file) && isUntraceableReader(readSource(file))).sort();
}

function git(args, root = repoRoot) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
}

function outputs(values) {
  const text = Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n');
  console.log(text);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${text}\n`);
}

export function listDiff(env = process.env, runGit = git) {
  if (env.GITHUB_EVENT_NAME !== 'pull_request' || env.FORCE_FULL === 'true') return { files: '', 'related-safe': 'false' };
  try {
    const { PR_BASE_SHA: base, PR_HEAD_SHA: head } = env;
    if (![base, head].every(sha => /^[a-f0-9]{40}$/.test(sha ?? ''))) throw new Error('invalid commit');
    const mergeBase = runGit(['merge-base', base, head]).trim();
    if (!/^[a-f0-9]{40}$/.test(mergeBase)) throw new Error('invalid merge base');
    const diff = parseDiff(runGit(['diff', '--no-renames', '--name-status', '-z', mergeBase, head]));
    const files = JSON.stringify(diff.files);
    if (diff.files.length > 3000 || Buffer.byteLength(files) > 300_000) throw new Error('diff too large');
    return { files, 'related-safe': String(diff.relatedSafe) };
  } catch (error) {
    console.warn(`Cannot select PR tests: ${error.message}`);
    return { files: '', 'related-safe': 'false' };
  }
}

export async function discoverRelated(vitest, changedFiles, readerSeeds) {
  const all = await vitest.globTestSpecifications();
  if (!all.length) throw new Error('empty client suite');
  const allIds = new Set(all.map(spec => spec.moduleId));
  for (const file of changedFiles) {
    if (TEST.test(file) && !allIds.has(file)) continue;
    vitest.config.related = [file];
    if (!(await vitest.getRelevantTestSpecifications()).length) throw new Error(`untraceable changed source: ${file}`);
  }
  vitest.config.related = [...new Set([...changedFiles, ...readerSeeds])];
  const selected = await vitest.getRelevantTestSpecifications();
  const selectedIds = new Set(selected.map(spec => spec.moduleId));
  for (const file of changedFiles.filter(file => TEST.test(file))) {
    if (allIds.has(file) && !selectedIds.has(file)) throw new Error(`changed test not selected: ${file}`);
  }
  // No graph edge for a changed source is ambiguous, not proof that no test is affected.
  if (!selected.length) throw new Error('no related tests');
  return selected;
}

export async function runRelated({ plan, script, shard = '', root = repoRoot, create, run = spawnSync }) {
  if (!['test', 'test:integration'].includes(script)) throw new Error('invalid client test lane');
  if (shard && !/^--shard=[1-3]\/3$/.test(shard)) throw new Error('invalid shard');
  if (script === 'test:integration' && shard) throw new Error('integration lane is not sharded');
  if (script === 'test:integration') process.env.CLIENT_TEST_LANE = 'integration';
  else delete process.env.CLIENT_TEST_LANE;
  const cwd = join(root, 'apps/client');
  let vitest;
  let selected;
  try {
    if (plan?.mode !== 'related' || planClientRelated(plan.files).mode !== 'related') throw new Error('full client plan');
    for (const file of plan.files) if (!statSync(join(root, file)).isFile()) throw new Error('missing changed file');
    const files = git(['ls-files', '-z'], root).split('\0').filter(Boolean);
    const readers = conservativeSeeds(files, file => readFileSync(join(root, file), 'utf8'));
    const factory = create ?? (await import('vitest/node')).createVitest;
    vitest = await factory('test', {
      root: cwd,
      watch: false,
      passWithNoTests: true,
      ...(shard ? { shard: shard.slice('--shard='.length) } : {}),
    });
    selected = await discoverRelated(vitest, plan.files.map(file => resolve(root, file)), readers.map(file => resolve(root, file)));
    if (selected.some(spec => !isAbsolute(spec.moduleId) || relative(cwd, spec.moduleId).startsWith('..'))) {
      throw new Error('test outside client');
    }
  } catch (error) {
    await vitest?.close();
    console.warn(`Related selection unavailable (${error.message}); running full client ${script}.`);
    const result = run('pnpm', ['--filter', '@bike4mind/client', script, ...(shard ? [shard] : [])], {
      cwd: root, stdio: 'inherit', env: process.env,
    });
    return result.status ?? 1;
  }
  try {
    console.log(`Client ${script}: ${selected.length} related test specification(s), ${shard || 'unsharded'}; bypassing turbo cache.`);
    await vitest.standalone();
    const result = await vitest.runTestSpecifications(selected, false);
    return result.unhandledErrors.length || result.testModules.some(test => !test.ok()) ? 1 : 0;
  } finally {
    await vitest.close();
  }
}

async function main() {
  if (process.argv[2] === 'diff') return outputs(listDiff());
  if (process.argv[2] !== 'run') throw new Error('usage: ci-related-tests.mjs diff|run');
  let plan;
  try { plan = JSON.parse(process.env.CLIENT_RELATED ?? 'null'); } catch { /* Run the full lane. */ }
  const script = process.env.SHARD_SCRIPT;
  process.exitCode = await runRelated({ plan, script, shard: process.env.SHARD_ARGS ?? '' });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
