#!/usr/bin/env node
// Manage premium-overlay.lock.json entries for branch-based preview testing.
//
// The lock file already supports pinning an overlay to a branch instead of a
// SHA (bootstrap-premium.sh and _deploy-env.yml both accept either), and
// ci.yml's merge-queue gate + _deploy-env.yml's post-merge backstop
// already refuse to let a branch pin reach main. This CLI is a thin,
// deterministic wrapper over that existing mechanism, not a replacement for
// it - it never touches CI, only this file.
//
// Usage:
//   pnpm premium:pin <name>=<branch>   Pin an overlay to a branch for preview testing
//   pnpm premium:pin <name> --merged   Resolve <name>'s branch pin to its latest commit SHA
//   pnpm premium:pin --check           Verify every pin is a 40-char SHA (mirrors the
//                                      merge-queue gate locally, before you push)
//
// Env:
//   PREMIUM_OVERLAY_OWNER=Bike4Mind    GitHub org/owner the overlays live in (default: Bike4Mind)
//
// <name> is the short overlay name (packages/premium/<name>), matched against
// keys already in premium-overlay.lock.json - never a second, hardcodable list.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCK_FILE = path.join(REPO_ROOT, 'premium-overlay.lock.json');
// Mirrors ci.yml's merge-queue gate regex exactly (re.fullmatch(r'[0-9a-f]{40}', ...)).
const SHA_RE = /^[0-9a-f]{40}$/;
// Mirrors bootstrap-premium.sh's ref guard: alphanumeric/underscore start, repo-safe chars, no '..'.
const REF_RE = /^[A-Za-z0-9_][A-Za-z0-9._/-]*$/;

function readLock() {
  if (!fs.existsSync(LOCK_FILE)) {
    console.error(`Error: ${path.relative(REPO_ROOT, LOCK_FILE)} not found`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
}

function writeLock(pins) {
  fs.writeFileSync(LOCK_FILE, `${JSON.stringify(pins, null, 2)}\n`);
}

function keyForName(pins, name) {
  const key = name.startsWith('b4m-') ? name : `b4m-${name}`;
  if (!(key in pins)) {
    const available = Object.keys(pins)
      .map((k) => k.replace(/^b4m-/, ''))
      .join(', ');
    console.error(`Error: '${name}' matches no entry in premium-overlay.lock.json. Available: ${available}`);
    process.exit(1);
  }
  return key;
}

function printUsage() {
  console.log(`Usage:
  pnpm premium:pin <name>=<branch>   Pin an overlay to a branch for preview testing
  pnpm premium:pin <name> --merged   Resolve <name>'s branch pin to its latest commit SHA
  pnpm premium:pin --check           Verify every pin is a 40-char SHA (local merge-gate check)

Env:
  PREMIUM_OVERLAY_OWNER=Bike4Mind     GitHub org/owner the overlays live in (default: Bike4Mind)`);
}

function cmdCheck(pins) {
  const bad = Object.entries(pins).filter(([, ref]) => !SHA_RE.test(String(ref)));
  if (bad.length === 0) {
    console.log(`All ${Object.keys(pins).length} premium overlay pins are 40-char SHAs.`);
    return;
  }
  for (const [key, ref] of bad) {
    console.error(
      `premium-overlay.lock.json '${key}' is not a 40-char SHA (got: ${ref}) - this will fail the merge-queue gate on main.`
    );
  }
  process.exit(1);
}

function cmdMerged(pins, name) {
  const key = keyForName(pins, name);
  const ref = pins[key];
  if (SHA_RE.test(ref)) {
    console.log(`${key} is already pinned to a SHA (${ref}) - nothing to resolve.`);
    return;
  }
  // Defense-in-depth: the lock file is hand-editable, so validate its current ref
  // the same way cmdPin validates a new one before it reaches `gh api`.
  if (ref.includes('..') || !REF_RE.test(ref)) {
    console.error(`Error: '${key}' has a malformed ref in premium-overlay.lock.json: '${ref}'`);
    process.exit(1);
  }
  const owner = process.env.PREMIUM_OVERLAY_OWNER || 'Bike4Mind';
  const repo = `${owner}/${key}`;
  console.log(`Resolving ${repo}@${ref} to its latest commit SHA...`);
  const sha = execFileSync('gh', ['api', `repos/${repo}/commits/${ref}`, '--jq', '.sha'], {
    encoding: 'utf8',
  }).trim();
  if (!SHA_RE.test(sha)) {
    console.error(`Error: unexpected response from gh api (not a 40-char SHA): '${sha}'`);
    process.exit(1);
  }
  pins[key] = sha;
  writeLock(pins);
  console.log(`${key}: ${ref} -> ${sha}`);
}

function cmdPin(pins, name, ref) {
  const key = keyForName(pins, name);
  if (ref.includes('..') || !(SHA_RE.test(ref) || REF_RE.test(ref))) {
    console.error(`Error: malformed ref '${ref}' - must be a 40-char SHA or a branch/tag name.`);
    process.exit(1);
  }
  pins[key] = ref;
  writeLock(pins);
  const name_ = key.replace(/^b4m-/, '');
  console.log(
    `${key}: pinned to '${ref}'. Before merging to main: run 'pnpm premium:pin ${name_} --merged' to ` +
      `bump this to a SHA (the merge-queue gate rejects a branch pin), then re-hydrate with ` +
      `'rm -rf packages/premium/${name_} && pnpm bootstrap:premium'.`
  );
}

const args = process.argv.slice(2);

if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
  printUsage();
  process.exit(args.length === 0 ? 1 : 0);
}

const pins = readLock();

if (args[0] === '--check') {
  cmdCheck(pins);
} else if (args.length === 2 && args[1] === '--merged') {
  cmdMerged(pins, args[0]);
} else if (args.length === 1 && args[0].includes('=')) {
  const eq = args[0].indexOf('=');
  cmdPin(pins, args[0].slice(0, eq), args[0].slice(eq + 1));
} else {
  printUsage();
  process.exit(1);
}
