#!/usr/bin/env node

// Decides which packages a pull_request run of ci.yml's `test-shards` job tests, from the PR's own
// diff against its merge base. Same selection as `pnpm verify` (selectAffected in
// verify-affected.mjs), so a local verify and the PR's CI agree.
//
//   node scripts/ci-affected-tests.mjs plan
//     In `core-build`, after install. Reads CHANGED_FILES (a JSON array from the `changes` job,
//     empty on push or when the diff could not be listed) and writes the `affected` output:
//     {"full":true} or {"full":false,"packages":[...],"workspace":[...]}.
//
//   node scripts/ci-affected-tests.mjs shard
//     In each leg, before its setup. Narrows SHARD_FILTER and INTEGRATION_FILTER to the affected
//     packages and writes `unit-filter`, `integration-filter` and `setup` outputs.
//
// Fails open: any error, a missing or unparsable plan, or a full plan runs the leg's whole filter.

import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WHOLE_REPO_TEST_PACKAGES } from './turbo-test-cache.mjs';
import { planClientRelated } from './ci-related-tests.mjs';
import { readPackageDirs, readTurboJson, selectAffected, turboFilters } from './verify-affected.mjs';

export const TEST_TASKS = ['test', 'test:integration'];

// Beyond verify's full-run files: the workflow and the selection code itself, so a change to how
// legs are chosen is tested by every leg.
const CI_FULL_RUN = [/^\.github\//, /^scripts\/(ci-affected-tests|ci-related-tests|verify-affected|turbo-test-cache)\.mjs$/];

export function planAffected({ changedFiles, turbo, packageDirs }) {
  if (!Array.isArray(changedFiles) || changedFiles.some(file => typeof file !== 'string')) return { full: true, reason: 'no changed-file list' };
  if (changedFiles.some(file => CI_FULL_RUN.some(pattern => pattern.test(file)))) {
    return { full: true, reason: 'CI or selection code changed' };
  }
  const selection = selectAffected({ changedFiles, turbo, packageDirs, tasks: TEST_TASKS });
  if (selection.full) return { full: true, reason: 'root config, lockfile or a turbo global dependency changed' };
  return { full: false, selection };
}

// The selection's packages as names, plus WHOLE_REPO_TEST_PACKAGES: their suites read the repo far
// outside their own inputs, so no diff can rule them out.
export function affectedPackages(selection, workspace, listPackages = readPackageDirs) {
  const filters = turboFilters(selection);
  const selected = filters.length ? Object.keys(listPackages(filters)) : [];
  const wholeRepo = WHOLE_REPO_TEST_PACKAGES.filter(name => workspace.includes(name));
  return [...new Set([...selected, ...wholeRepo])].sort();
}

// The package names a leg's bare `--filter <name>` / `--filter !<name>` pairs select, as pnpm and
// turbo read them: only exclusions means every workspace package but those.
export function resolveFilter(filter, workspace) {
  const tokens = filter.split(/\s+/).filter(Boolean);
  if (tokens.length % 2) throw new Error(`unpaired --filter in: ${filter}`);
  const include = [];
  const exclude = [];
  for (let i = 0; i < tokens.length; i += 2) {
    const pattern = tokens[i + 1];
    if (tokens[i] !== '--filter' || !/^!?@[\w.-]+\/[\w.-]+$/.test(pattern)) {
      throw new Error(`not a bare --filter <package> pair: ${tokens[i]} ${pattern}`);
    }
    (pattern.startsWith('!') ? exclude : include).push(pattern.replace(/^!/, ''));
  }
  const base = include.length ? include.filter(name => workspace.includes(name)) : workspace;
  return base.filter(name => !exclude.includes(name));
}

const toFilter = names => names.map(name => `--filter ${name}`).join(' ');

/**
 * One leg's narrowed filters. `emptyLanes` names a declared filter that matches no workspace
 * package: a misconfigured matrix, which the caller fails on, as the test steps' guard does.
 */
export function planShard({ plan, unitFilter, integrationFilter, alwaysSetup }) {
  const declared = { unit: unitFilter ?? '', integration: integrationFilter ?? '' };
  if (!plan || plan.full) {
    return {
      unitFilter: declared.unit,
      integrationFilter: declared.integration,
      setup: true,
      emptyLanes: [],
      skipped: [],
    };
  }
  const narrowed = {};
  const emptyLanes = [];
  const skipped = [];
  for (const [lane, filter] of Object.entries(declared)) {
    if (!filter) {
      narrowed[lane] = '';
      continue;
    }
    const names = resolveFilter(filter, plan.workspace);
    if (!names.length) emptyLanes.push(lane);
    narrowed[lane] = toFilter(names.filter(name => plan.packages.includes(name)));
    skipped.push(...names.filter(name => !plan.packages.includes(name)).map(name => `${name} (${lane})`));
  }
  return {
    unitFilter: narrowed.unit,
    integrationFilter: narrowed.integration,
    setup: Boolean(alwaysSetup || narrowed.unit || narrowed.integration),
    emptyLanes,
    skipped,
  };
}

function parsePlan(text) {
  try {
    const plan = JSON.parse(text);
    if (plan.full === false && Array.isArray(plan.packages) && Array.isArray(plan.workspace)) return plan;
  } catch {
    // Empty or garbled: run the whole leg.
  }
  return null;
}

function writeOutputs(outputs) {
  const lines = Object.entries(outputs).map(([key, value]) => `${key}=${value}`);
  console.log(lines.join('\n'));
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
}

function summary(text) {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
}

function plan() {
  let result;
  try {
    const raw = process.env.CHANGED_FILES;
    const changedFiles = raw ? JSON.parse(raw) : null;
    const packageDirs = readPackageDirs();
    const planned = planAffected({ changedFiles, turbo: readTurboJson(), packageDirs });
    if (planned.full) {
      result = { full: true };
      console.log(`affected: every package (${planned.reason})`);
    } else {
      const workspace = Object.keys(packageDirs).sort();
      const packages = affectedPackages(planned.selection, workspace);
      result = { full: false, packages, workspace, client: planClientRelated(changedFiles, process.env.RELATED_SAFE === 'true') };
      console.log(`changed: ${planned.selection.changed.join(', ') || '(none)'}`);
      console.log(`reached through turbo.json inputs: ${planned.selection.extra.join(', ') || '(none)'}`);
      console.log(`affected (${packages.length}/${workspace.length}): ${packages.join(', ')}`);
      summary(`Affected test packages (${packages.length}/${workspace.length}): ${packages.join(', ')}`);
    }
  } catch (error) {
    console.log(`::warning title=Affected tests::${String(error.message).split('\n')[0]}; testing every package.`);
    result = { full: true };
  }
  writeOutputs({ affected: JSON.stringify(result) });
}

function shard() {
  const name = process.env.SHARD_NAME;
  let result;
  try {
    result = planShard({
      plan: parsePlan(process.env.AFFECTED ?? ''),
      unitFilter: process.env.SHARD_FILTER,
      integrationFilter: process.env.INTEGRATION_FILTER,
      alwaysSetup: process.env.ALWAYS_SETUP === 'true',
    });
  } catch (error) {
    console.log(`::warning title=Affected tests::${error.message}; running the whole ${name} leg.`);
    result = planShard({
      plan: null,
      unitFilter: process.env.SHARD_FILTER,
      integrationFilter: process.env.INTEGRATION_FILTER,
    });
  }
  if (result.emptyLanes.length) {
    console.log(
      `::error title=Empty test shard::The ${name} leg's ${result.emptyLanes.join(' and ')} filter matches no workspace package, so it would run no tests. Check the --filter tokens in the matrix.`
    );
    process.exit(1);
  }
  if (result.skipped.length) {
    console.log(`not affected by this PR, skipped: ${result.skipped.join(', ')}`);
    summary(`- ${name}: skipped ${result.skipped.join(', ')} (not affected by this PR)`);
  }
  writeOutputs({
    'unit-filter': result.unitFilter,
    'integration-filter': result.integrationFilter,
    'client-related': JSON.stringify(parsePlan(process.env.AFFECTED ?? '')?.client ?? { mode: 'full' }),
    setup: String(result.setup),
  });
}

const commands = { plan, shard };

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = commands[process.argv[2]];
  if (!command) {
    console.error(`usage: ci-affected-tests.mjs ${Object.keys(commands).join('|')}`);
    process.exit(2);
  }
  command();
}
