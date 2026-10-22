#!/usr/bin/env node
/**
 * Measure the OpenNext server-function bundles against Lambda's unzipped-size limit.
 *
 * Lambda rejects a deployment package whose UNZIPPED contents exceed 262144000 bytes, and that
 * limit is not adjustable - there is no quota increase to request, and the only escape hatch is
 * container-image packaging. Nothing measured this before, so the bundle reached 92.8% of the
 * ceiling unnoticed and the first signal was a failed deploy whose error named a Lambda that had
 * nothing to do with the cause. This script exists so the number is always printed.
 *
 * The zipped size is NOT a usable proxy: this bundle compresses about 3x, so the S3 object looks
 * comfortable at ~78 MB while the unzipped contents sit against the ceiling.
 *
 * Every directory under `.open-next/server-functions/` is measured, not just `default`: OpenNext
 * can split the server into several functions and each one is its own deployment package with its
 * own copy of this limit. The layout (unchanged from OpenNext v3 to v4) is coupled to
 * `openNextVersion` in infra/web.ts, so a major bump there wants a look at this path.
 *
 * Modes:
 *   --enforce          exit non-zero when any bundle is over budget
 *   --dir=<path>       measure exactly this one directory instead of discovering them
 *   --reserve-mib=<n>  add n MiB to every measured bundle before judging it, for bytes the deployed
 *                      package carries that this build does not (a build without the premium
 *                      overlays). Passed but empty means no allowance is known: warn, apply none.
 *
 * Above the warn fraction a bundle gets a warning annotation but never fails, so the trend through
 * the 80s is visible before the budget cliff.
 */

import { realpathSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Lambda's hard cap on unzipped deployment-package bytes. Not raisable.
 * Same limit as `scripts/check-opennext-build.mjs`, which spells it `250 * 1024 * 1024`;
 * keep the two in sync.
 */
export const LAMBDA_UNZIPPED_LIMIT_BYTES = 262144000;

/** Fraction of the limit we allow before the budget is considered breached. */
export const DEFAULT_BUDGET_FRACTION = 0.9;

/** Fraction of the limit above which a bundle is flagged, without failing, as nearing the budget. */
export const DEFAULT_WARN_FRACTION = 0.85;

const MIB = 1048576;

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const SERVER_FUNCTIONS_ROOT = join(REPO_ROOT, 'apps/client/.open-next/server-functions');

/**
 * Budget arithmetic, split out from the filesystem walk so it is unit-testable.
 *
 * `over-limit` means AWS itself would reject the package; `over-budget` means we are inside the
 * red zone we refuse to operate in, with headroom left to react; `near-budget` is a warning only.
 * `judgedBytes` in the result is `measuredBytes + reserveBytes`, the figure every status is judged on.
 */
export function evaluateBudget({
  measuredBytes,
  reserveBytes = 0,
  limitBytes = LAMBDA_UNZIPPED_LIMIT_BYTES,
  budgetFraction = DEFAULT_BUDGET_FRACTION,
  warnFraction = DEFAULT_WARN_FRACTION,
}) {
  const judgedBytes = measuredBytes + reserveBytes;
  const budgetBytes = Math.floor(limitBytes * budgetFraction);
  const warnBytes = Math.floor(limitBytes * warnFraction);
  const status =
    judgedBytes > limitBytes
      ? 'over-limit'
      : judgedBytes > budgetBytes
        ? 'over-budget'
        : judgedBytes > warnBytes
          ? 'near-budget'
          : 'ok';
  return {
    status,
    judgedBytes,
    measuredBytes,
    reserveBytes,
    limitBytes,
    budgetBytes,
    warnBytes,
    percentOfLimit: (judgedBytes / limitBytes) * 100,
    headroomBytes: limitBytes - judgedBytes,
  };
}

const STATUS_SEVERITY = { ok: 0, 'near-budget': 1, 'over-budget': 2, 'over-limit': 3 };

/** Whether a status fails the gate under --enforce. `near-budget` only warns. */
export function failsBudget(status) {
  return STATUS_SEVERITY[status] >= STATUS_SEVERITY['over-budget'];
}

/**
 * Parse the --reserve-mib value into bytes. `undefined` (flag absent) and '' (flag passed from an
 * unset CI variable) both mean no allowance; anything else must be a plain non-negative decimal
 * number of MiB, so a typo in the repository variable fails loudly instead of being read as some
 * other value (`Number()` alone would take "0x10" as 16 and "1e3" as 1000).
 */
export function parseReserveMib(value) {
  if (value === undefined) return 0;
  const trimmed = value.trim();
  if (trimmed === '') return 0;
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`--reserve-mib must be a non-negative number of MiB, got "${value}"`);
  }
  return Math.round(Number(trimmed) * MIB);
}

/** The worst status across several bundles, since one oversized package fails the whole deploy. */
export function worstStatus(statuses) {
  return statuses.reduce((worst, next) => (STATUS_SEVERITY[next] > STATUS_SEVERITY[worst] ? next : worst), 'ok');
}

const megabytes = bytes => (bytes / MIB).toFixed(1);

/**
 * Recursively collect [relativePath, bytes] for every regular file under `root`.
 * Must stay in sync with `bundleSize` in `scripts/check-opennext-build.mjs`, which measures the
 * same output: a symlinked directory contributes nothing to the zipped package, and a symlinked
 * file is counted at its target's size. Over-reporting can only fail a bundle that would have
 * fit; under-reporting would pass one the deploy then rejects.
 */
async function collectFiles(root) {
  const files = [];
  const walk = async dir => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        const stats = await stat(full).catch(() => null);
        if (stats?.isFile()) files.push([relative(root, full), stats.size]);
      }
    }
  };
  await walk(root);
  return files;
}

/**
 * Group by the first three path segments, which is the granularity that names a culprit:
 * `node_modules/.pnpm/googleapis@173.0.0` is actionable, `node_modules` is not.
 */
export function topContributors(files, count = 15) {
  const totals = new Map();
  for (const [path, bytes] of files) {
    const key = path.split(sep).slice(0, 3).join('/');
    totals.set(key, (totals.get(key) ?? 0) + bytes);
  }
  return [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, count);
}

/** Repo-relative where possible; an explicit --dir outside the repo prints as given. */
function label(dir) {
  const rel = relative(REPO_ROOT, dir);
  return !rel || rel.startsWith('..') ? dir : rel;
}

async function measure(dir, reserveBytes) {
  const files = await collectFiles(dir);
  const measuredBytes = files.reduce((sum, [, bytes]) => sum + bytes, 0);
  return {
    dir,
    fileCount: files.length,
    contributors: topContributors(files),
    ...evaluateBudget({ measuredBytes, reserveBytes }),
  };
}

function report(result) {
  console.log(`\n${label(result.dir)}`);
  console.log(`  ${megabytes(result.measuredBytes)} MB unzipped across ${result.fileCount} files`);
  if (result.reserveBytes) {
    console.log(
      `  + ${megabytes(result.reserveBytes)} MB reserve for bytes not in this build = ${megabytes(result.judgedBytes)} MB judged`
    );
  }
  console.log(
    `  limit ${megabytes(result.limitBytes)} MB, budget ${megabytes(result.budgetBytes)} MB ` +
      `(${(DEFAULT_BUDGET_FRACTION * 100).toFixed(0)}%), warn ${megabytes(result.warnBytes)} MB ` +
      `(${(DEFAULT_WARN_FRACTION * 100).toFixed(0)}%), now ${result.percentOfLimit.toFixed(1)}% ` +
      `with ${megabytes(result.headroomBytes)} MB headroom`
  );
  console.log('  heaviest paths:');
  for (const [path, bytes] of result.contributors) {
    console.log(`    ${megabytes(bytes).padStart(8)} MB  ${path}`);
  }
}

function summarize(result) {
  return (
    `${label(result.dir)} is ${megabytes(result.judgedBytes)} MB unzipped${result.reserveBytes ? ' with reserve' : ''} ` +
    `(${result.percentOfLimit.toFixed(1)}% of Lambda's ${megabytes(result.limitBytes)} MB unzipped limit, ` +
    `budget ${megabytes(result.budgetBytes)} MB). Trim it or move the Next server to container-image ` +
    `packaging; the limit itself cannot be raised.`
  );
}

async function main() {
  const args = process.argv.slice(2);
  const enforce = args.includes('--enforce');
  const dirArg = args.find(a => a.startsWith('--dir='));
  const reserveArg = args.find(a => a === '--reserve-mib' || a.startsWith('--reserve-mib='));

  if (reserveArg === '--reserve-mib') {
    console.error('::error::--reserve-mib needs a value, e.g. --reserve-mib=64');
    process.exit(2);
  }

  const reserveValue = reserveArg?.slice('--reserve-mib='.length);
  let reserveBytes;
  try {
    reserveBytes = parseReserveMib(reserveValue);
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exit(2);
  }
  if (reserveValue !== undefined && reserveValue.trim() === '') {
    console.log(
      '::warning::--reserve-mib is empty, so no allowance is applied for bytes the deployed bundle carries ' +
        'that this build does not. The measured size may undercount the deployed one.'
    );
  }

  let dirs;
  try {
    dirs = dirArg
      ? [resolve(dirArg.slice('--dir='.length))]
      : (await readdir(SERVER_FUNCTIONS_ROOT, { withFileTypes: true }))
          .filter(entry => entry.isDirectory())
          .map(entry => join(SERVER_FUNCTIONS_ROOT, entry.name));
  } catch (error) {
    // Deliberately not a soft skip: the point of this script is that the number is never missing.
    // A caller that runs it when the build may legitimately not have happened must decide that
    // for itself rather than have an absent measurement read as a pass.
    console.error(`::error::Could not find the server functions at ${SERVER_FUNCTIONS_ROOT}: ${error.message}`);
    process.exit(2);
  }

  if (dirs.length === 0) {
    console.error(`::error::No server-function directories under ${SERVER_FUNCTIONS_ROOT}`);
    process.exit(2);
  }

  const results = [];
  for (const dir of dirs) {
    try {
      const result = await measure(dir, reserveBytes);
      report(result);
      results.push(result);
    } catch (error) {
      console.error(`::error::Could not measure the server bundle at ${label(dir)}: ${error.message}`);
      process.exit(2);
    }
  }

  await writeStepSummary(results);

  for (const result of results.filter(r => r.status !== 'ok')) {
    const level = enforce && failsBudget(result.status) ? '::error::' : '::warning::';
    console.log(`${level}${summarize(result)}`);
  }

  if (enforce && failsBudget(worstStatus(results.map(r => r.status)))) process.exit(1);
}

/** Put the number on the run's summary page, so nobody has to open the log to find it. */
async function writeStepSummary(results) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;
  const { appendFile } = await import('node:fs/promises');
  const rows = results.map(
    r =>
      `| ${label(r.dir)} | ${megabytes(r.measuredBytes)} MB | ${megabytes(r.reserveBytes)} MB | ` +
      `${megabytes(r.judgedBytes)} MB | ${r.percentOfLimit.toFixed(1)}% | ` +
      `${megabytes(r.headroomBytes)} MB | ${r.status} |`
  );
  const heaviest = results
    .flatMap(r => r.contributors.slice(0, 10).map(([path, bytes]) => `| ${path} | ${megabytes(bytes)} MB |`))
    .join('\n');
  await appendFile(
    summaryPath,
    [
      '### Server bundle vs Lambda unzipped limit',
      '',
      '| bundle | unzipped | reserve | judged | of limit | headroom | status |',
      '| --- | --- | --- | --- | --- | --- | --- |',
      ...rows,
      '',
      '<details><summary>Heaviest paths</summary>',
      '',
      '| path | size |',
      '| --- | --- |',
      heaviest,
      '',
      '</details>',
      '',
    ].join('\n')
  );
}

// Only run when invoked directly, so the exported helpers stay importable from tests. argv[1] keeps
// the path as given, while import.meta.url is the resolved one, so a symlinked invocation would not
// match and main() would be skipped - a silent pass for a gate. Resolve both sides; an argv[1] that
// does not resolve is simply not a direct invocation, not a reason to throw out of an import.
const invokedPath = (() => {
  try {
    return realpathSync(process.argv[1]);
  } catch {
    return null;
  }
})();
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  await main();
}
