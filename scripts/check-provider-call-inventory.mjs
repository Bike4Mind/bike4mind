#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CATALOG_PATH = 'scripts/unmetered-provider-call-allowlist.txt';
export const INITIAL_EXCEPTION_SEED = '6e8dc820fc9b602312b015fbda796f59d2036119b0a024e37e0879d9ea3c7bed';

export function parseCatalog(text) {
  return text
    .split('\n')
    .filter(line => line.trim() && !line.startsWith('#'))
    .map(line => JSON.parse(line));
}

export const isProviderException = entry =>
  entry.classification === 'debt' ||
  (entry.classification === 'forwarded' && /#(?:completion|sdk-send):/.test(entry.id));

export function checkDebtSubset(current, base, initialSeed = INITIAL_EXCEPTION_SEED) {
  const debt = current
    .filter(isProviderException)
    .map(entry => entry.id)
    .sort();
  if (null === base) {
    const seed = createHash('sha256').update(debt.join('\n')).digest('hex');
    if (seed !== initialSeed) throw new Error('Initial provider exception inventory differs from its reviewed seed.');
    return;
  }
  const previousDebt = new Set(base.filter(entry => entry.classification === 'debt').map(entry => entry.id));
  const newDebt = current.filter(entry => entry.classification === 'debt' && !previousDebt.has(entry.id));
  if (newDebt.length)
    throw new Error(`Provider debt inventory must only shrink:\n${newDebt.map(entry => entry.id).join('\n')}`);
  const previous = new Set(base.filter(isProviderException).map(entry => entry.id));
  const added = debt.filter(id => !previous.has(id));
  if (added.length) throw new Error(`Provider exception inventory must only shrink:\n${added.join('\n')}`);
}

export function eventBase(env = process.env, read = readFileSync) {
  if (env.GITHUB_EVENT_PATH) {
    const event = JSON.parse(read(env.GITHUB_EVENT_PATH, 'utf8'));
    const base = event.pull_request?.base?.sha ?? event.before;
    if (base && !/^0+$/.test(base)) return base;
  }
  return 'origin/main';
}

export function readBaseCatalog(
  root,
  baseRef,
  runGit = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' })
) {
  const commit = runGit(['rev-parse', '--verify', '--end-of-options', `${baseRef}^{commit}`]).trim();
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Provider inventory base did not resolve to a commit.');
  const present = runGit(['ls-tree', '--name-only', commit, '--', CATALOG_PATH]).trim();
  return present ? parseCatalog(runGit(['show', `${commit}:${CATALOG_PATH}`])) : null;
}

export function checkInventory(root, baseRef = eventBase()) {
  const entries = parseCatalog(readFileSync(resolve(root, CATALOG_PATH), 'utf8'));
  checkDebtSubset(entries, readBaseCatalog(root, baseRef));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 2 || args[0] !== '--base'))
      throw new Error('Usage: check-provider-call-inventory.mjs [--base <git-ref>]');
    checkInventory(root, args[1] ?? eventBase());
    console.log('OK: Provider exception inventory did not grow.');
  } catch (error) {
    console.error(`ERROR: ${error.message}`);
    process.exitCode = 1;
  }
}
