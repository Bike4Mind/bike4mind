#!/usr/bin/env node
// Rejects hand-picked core migration ids. Every core migration a change adds must carry an id
// that `pnpm migrate generate` stamped from the real UTC clock:
//
//   - a real UTC timestamp, YYYYMMDDHHMMSS (no hour 24, no second 99, no Feb 30);
//   - not in the future beyond MAX_FUTURE_SKEW_MS;
//   - not older than the change's own start (see `floorFor`) minus MAX_AGE_GRACE_MS.
//
// Generated ids are distinct unless two people run the generator in the same second, so two PRs
// that pass this check cannot collide, with no merge queue and no "branch must be up to date"
// rule. Hand-picked ids (squeezed in below the current max, or reused from a neighbour) are what
// collided before. Squeezing below the max buys nothing anyway: MigrationManager.up() runs every
// id not yet applied, not only ids above the highest applied one.
//
// Only files the change ADDS are checked: present in <head>'s migrations directory but not at the
// fork point (merge-base of <base> and <head>). Comparing with the base tip instead would read a
// file main gained after the fork as a slug rename of the head's file with the same id, and skip
// it. Existing files are grandfathered, and renaming an existing file's slug (same id) is not
// an addition. An added file that reuses an id another file still holds always fails, even when
// that id is on the base already. Uniqueness across the whole directory is enforced separately by
// packages/scripts/migrate/migrations/index.test.ts, which runs on every push to main.
//
// Usage: node scripts/check-migration-ids.mjs --base <rev> [--head <rev>]
//   --base  the base branch tip (scripts/resolve-guard-base.sh). Required: with no base there is
//           no way to tell added ids from grandfathered ones, so a missing base fails.
//   --head  the change's own tip (defaults to HEAD). On a pull_request run pass the PR head, not
//           the merge ref, so the merge-base below is the PR's real fork point.

import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

export const MIGRATIONS_DIR = 'packages/scripts/migrate/migrations';
// Top-level files only; same shape as CORE_MIGRATION_FILE_RE in
// apps/client/scripts/generate-premium-glue.mjs, but any digit count, so a malformed id is
// reported instead of skipped.
const MIGRATION_FILE_RE = /^(\d+)[-_].+\.ts$/;
const ID_RE = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/;

export const MAX_FUTURE_SKEW_MS = 60 * 60 * 1000;
export const MAX_AGE_GRACE_MS = 24 * 60 * 60 * 1000;

const HOW_TO_FIX =
  'Create migrations with `pnpm migrate generate "<name>"`, which stamps the current UTC time. ' +
  'Never hand-pick or reuse an id; to refresh a stale one, regenerate the file and move up()/down() into it.';

/** Parses a migration id into its UTC instant, or returns null when it is not a real timestamp. */
export function parseMigrationId(id) {
  const match = ID_RE.exec(id);
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  const ms = Date.UTC(year, month - 1, day, hour, minute, second);
  const date = new Date(ms);
  // Date.UTC rolls over out-of-range parts (hour 24 becomes the next day), so round-trip to
  // reject anything that is not literally a valid calendar time.
  const roundTrips =
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day &&
    date.getUTCHours() === hour &&
    date.getUTCMinutes() === minute &&
    date.getUTCSeconds() === second;
  return roundTrips ? ms : null;
}

/** Returns [{ id, filename }] for the migration files in a list of directory entries. */
export function migrationFilesIn(filenames) {
  return filenames
    .filter(filename => !filename.endsWith('.test.ts'))
    .map(filename => ({ filename, match: MIGRATION_FILE_RE.exec(filename) }))
    .filter(({ match }) => match)
    .map(({ filename, match }) => ({ id: match[1], filename }));
}

/**
 * Splits the head's migration files into the ones this change adds and the problems that need no
 * timestamp check: an added file that reuses an id another file still holds. A file whose id the
 * base already had, and whose base file is gone, is a slug rename and stays grandfathered.
 */
export function classifyAdded(baseFiles, headFiles) {
  const baseNames = new Set(baseFiles.map(f => f.filename));
  const headNames = new Set(headFiles.map(f => f.filename));
  const added = [];
  const problems = [];
  for (const file of headFiles) {
    if (baseNames.has(file.filename)) continue;
    const others = headFiles.filter(f => f.id === file.id && f.filename !== file.filename).map(f => f.filename);
    if (others.length > 0) {
      problems.push(`${file.filename}: id ${file.id} is already used by ${others.join(', ')}.`);
      continue;
    }
    const renamedFromBase = baseFiles.some(f => f.id === file.id && !headNames.has(f.filename));
    if (!renamedFromBase) added.push(file);
  }
  return { added, problems };
}

/**
 * Returns one human-readable problem per invalid added id. `added` is [{ id, filename, floorMs }].
 */
export function findProblems(added, nowMs) {
  const problems = [];
  for (const { id, filename, floorMs } of added) {
    const idMs = parseMigrationId(id);
    if (idMs === null) {
      problems.push(`${filename}: id ${id} is not a valid UTC timestamp (YYYYMMDDHHMMSS).`);
      continue;
    }
    if (idMs > nowMs + MAX_FUTURE_SKEW_MS) {
      problems.push(`${filename}: id ${id} is in the future (now is ${formatId(nowMs)} UTC).`);
      continue;
    }
    if (idMs < floorMs - MAX_AGE_GRACE_MS) {
      problems.push(
        `${filename}: id ${id} is older than this change (earliest allowed is ${formatId(floorMs - MAX_AGE_GRACE_MS)} UTC).`
      );
    }
  }
  return problems;
}

export function formatId(ms) {
  return new Date(ms)
    .toISOString()
    .replace(/\.\d{3}Z$/, '')
    .replace(/\D/g, '');
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function listMigrationFiles(cwd, rev) {
  const out = git(cwd, ['ls-tree', '--name-only', `${rev}:${MIGRATIONS_DIR}`]);
  return out ? out.split('\n') : [];
}

// The earliest an added id may be, before the grace period: the change's fork point, or the
// author date of the commit that added the file when that is earlier. Author date survives a
// rebase, so rebasing a long-lived PR onto a newer main does not invalidate an id that was fresh
// when it was generated; a hand-picked id is still caught because it predates both.
function floorFor(cwd, forkPoint, head, filename) {
  const forkPointMs = Date.parse(git(cwd, ['show', '-s', '--format=%cI', forkPoint]));
  const addedAt = git(cwd, [
    'log',
    '--format=%aI',
    '--diff-filter=A',
    `${forkPoint}..${head}`,
    '--',
    `${MIGRATIONS_DIR}/${filename}`,
  ])
    .split('\n')
    .filter(Boolean)
    .map(Date.parse);
  return Math.min(forkPointMs, ...addedAt);
}

/** Runs the check in a git checkout; returns the list of problems (empty when clean). */
export function checkMigrationIds({ cwd, base, head = 'HEAD', nowMs = Date.now() }) {
  const forkPoint = git(cwd, ['merge-base', base, head]);
  const { added, problems } = classifyAdded(
    migrationFilesIn(listMigrationFiles(cwd, forkPoint)),
    migrationFilesIn(listMigrationFiles(cwd, head))
  );
  const withFloors = added.map(file => ({ ...file, floorMs: floorFor(cwd, forkPoint, head, file.filename) }));
  return [...problems, ...findProblems(withFloors, nowMs)];
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    if (flag !== '--base' && flag !== '--head') throw new Error(`unknown argument ${flag}`);
    args[flag.slice(2)] = argv[i + 1];
  }
  return args;
}

function main() {
  const { base, head } = parseArgs(process.argv.slice(2));
  if (!base) {
    console.error('check-migration-ids: --base is required (no base, no way to tell added ids apart).');
    process.exit(1);
  }
  const problems = checkMigrationIds({ cwd: process.cwd(), base, head: head || 'HEAD' });
  if (problems.length === 0) {
    console.log('check-migration-ids: every added core migration id is a fresh generated timestamp.');
    return;
  }
  console.error('check-migration-ids: hand-picked or stale core migration id(s):');
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error(`\n${HOW_TO_FIX}`);
  process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
