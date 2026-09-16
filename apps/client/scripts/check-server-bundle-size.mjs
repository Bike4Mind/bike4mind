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
 * own copy of this limit. The layout is OpenNext v3's - it is coupled to `openNextVersion` in
 * infra/web.ts, so a major bump there wants a look at this path.
 *
 * Modes:
 *   --enforce      exit non-zero when any bundle is over budget
 *   --dir=<path>   measure exactly this one directory instead of discovering them
 */

import { readdir, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Lambda's hard cap on unzipped deployment-package bytes. Not raisable. */
export const LAMBDA_UNZIPPED_LIMIT_BYTES = 262144000;

/** Fraction of the limit we allow before the budget is considered breached. */
export const DEFAULT_BUDGET_FRACTION = 0.9;

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const SERVER_FUNCTIONS_ROOT = join(REPO_ROOT, 'apps/client/.open-next/server-functions');

/**
 * Budget arithmetic, split out from the filesystem walk so it is unit-testable.
 *
 * `over-limit` means AWS itself would reject the package; `over-budget` means we are inside the
 * red zone we refuse to operate in, with headroom left to react.
 */
export function evaluateBudget({
  totalBytes,
  limitBytes = LAMBDA_UNZIPPED_LIMIT_BYTES,
  budgetFraction = DEFAULT_BUDGET_FRACTION,
}) {
  const budgetBytes = Math.floor(limitBytes * budgetFraction);
  const status = totalBytes > limitBytes ? 'over-limit' : totalBytes > budgetBytes ? 'over-budget' : 'ok';
  return {
    status,
    totalBytes,
    limitBytes,
    budgetBytes,
    percentOfLimit: (totalBytes / limitBytes) * 100,
    headroomBytes: limitBytes - totalBytes,
  };
}

const STATUS_SEVERITY = { ok: 0, 'over-budget': 1, 'over-limit': 2 };

/** The worst status across several bundles, since one oversized package fails the whole deploy. */
export function worstStatus(statuses) {
  return statuses.reduce((worst, next) => (STATUS_SEVERITY[next] > STATUS_SEVERITY[worst] ? next : worst), 'ok');
}

const megabytes = bytes => (bytes / 1048576).toFixed(1);

/** Recursively collect [relativePath, bytes] for every regular file under `root`. */
async function collectFiles(root) {
  const files = [];
  const walk = async dir => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      // Symlinks are dereferenced by the packager, but counting a target twice would overstate
      // the total, so they are skipped here and the budget margin absorbs the difference.
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        files.push([relative(root, full), (await stat(full)).size]);
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

async function measure(dir) {
  const files = await collectFiles(dir);
  const totalBytes = files.reduce((sum, [, bytes]) => sum + bytes, 0);
  return { dir, fileCount: files.length, contributors: topContributors(files), ...evaluateBudget({ totalBytes }) };
}

function report(result) {
  console.log(`\n${label(result.dir)}`);
  console.log(`  ${megabytes(result.totalBytes)} MB unzipped across ${result.fileCount} files`);
  console.log(
    `  limit ${megabytes(result.limitBytes)} MB, budget ${megabytes(result.budgetBytes)} MB ` +
      `(${(DEFAULT_BUDGET_FRACTION * 100).toFixed(0)}%), now ${result.percentOfLimit.toFixed(1)}% ` +
      `with ${megabytes(result.headroomBytes)} MB headroom`
  );
  console.log('  heaviest paths:');
  for (const [path, bytes] of result.contributors) {
    console.log(`    ${megabytes(bytes).padStart(8)} MB  ${path}`);
  }
}

function summarize(result) {
  return (
    `${label(result.dir)} is ${megabytes(result.totalBytes)} MB unzipped ` +
    `(${result.percentOfLimit.toFixed(1)}% of Lambda's ${megabytes(result.limitBytes)} MB unzipped limit, ` +
    `budget ${megabytes(result.budgetBytes)} MB). Trim it or move the Next server to container-image ` +
    `packaging; the limit itself cannot be raised.`
  );
}

async function main() {
  const args = process.argv.slice(2);
  const enforce = args.includes('--enforce');
  const dirArg = args.find(a => a.startsWith('--dir='));

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
      const result = await measure(dir);
      report(result);
      results.push(result);
    } catch (error) {
      console.error(`::error::Could not measure the server bundle at ${label(dir)}: ${error.message}`);
      process.exit(2);
    }
  }

  await writeStepSummary(results);

  const breached = results.filter(r => r.status !== 'ok');
  for (const result of breached) {
    console.log(`${enforce ? '::error::' : '::warning::'}${summarize(result)}`);
  }

  if (enforce && worstStatus(results.map(r => r.status)) !== 'ok') process.exit(1);
}

/** Put the number on the run's summary page, so nobody has to open the log to find it. */
async function writeStepSummary(results) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;
  const { appendFile } = await import('node:fs/promises');
  const rows = results.map(
    r =>
      `| ${label(r.dir)} | ${megabytes(r.totalBytes)} MB | ${r.percentOfLimit.toFixed(1)}% | ` +
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
      '| bundle | unzipped | of limit | headroom | status |',
      '| --- | --- | --- | --- | --- |',
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

// Only run when invoked directly, so the exported helpers stay importable from tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
