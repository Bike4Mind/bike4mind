import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CATALOG_PATH,
  checkDebtSubset,
  eventBase,
  parseCatalog,
  readBaseCatalog,
} from '../check-provider-call-inventory.mjs';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const entry = (id, classification = 'debt') => ({ id, classification, reason: 'Reviewed source boundary.' });

it('allows debt to shrink and rejects both new debt and a forwarded-to-debt downgrade', () => {
  const base = [entry('one'), entry('two'), entry('forwarded', 'forwarded')];
  expect(() => checkDebtSubset([entry('one')], base)).not.toThrow();
  expect(() => checkDebtSubset([], base)).not.toThrow();
  expect(() => checkDebtSubset([entry('new')], base)).toThrow('must only shrink');
  expect(() => checkDebtSubset([entry('forwarded')], base)).toThrow('must only shrink');
});

it('ratchets grandfathered forwarded paid sends without treating factories as paid exceptions', () => {
  const paid = 'worker.ts#task#sdk-send:client.messages.create#1';
  const forwarded = entry(paid, 'forwarded');
  expect(() => checkDebtSubset([forwarded], [])).toThrow('must only shrink');
  expect(() => checkDebtSubset([forwarded], [forwarded])).not.toThrow();
  expect(() => checkDebtSubset([], [forwarded])).not.toThrow();
  expect(() => checkDebtSubset([entry(paid)], [forwarded])).toThrow('must only shrink');
  expect(() => checkDebtSubset([forwarded], [entry(paid)])).not.toThrow();
  expect(() => checkDebtSubset([entry('worker.ts#task#factory:getLlmByModel#1', 'forwarded')], [])).not.toThrow();
});

it('requires the reviewed initial seed only when a real base has no catalog', () => {
  const current = [entry('one')];
  const hash = createHash('sha256').update('one').digest('hex');
  expect(() => checkDebtSubset(current, null, hash)).not.toThrow();
  expect(() => checkDebtSubset([entry('new')], null, hash)).toThrow('reviewed seed');
  expect(() => checkDebtSubset([], null, hash)).toThrow('reviewed seed');
});

it('fails on missing base objects instead of interpreting them as bootstrap', () => {
  expect(() =>
    readBaseCatalog(root, 'missing', () => {
      throw new Error('missing commit');
    })
  ).toThrow('missing commit');
  expect(() => readBaseCatalog(root, 'missing', () => '')).toThrow('did not resolve');
});

it('distinguishes a missing catalog on an existing commit from a present stale baseline', () => {
  const sha = 'a'.repeat(40);
  const absent = args => (args[0] === 'rev-parse' ? sha : '');
  expect(readBaseCatalog(root, sha, absent)).toBeNull();
  const present = args =>
    args[0] === 'rev-parse' ? sha : args[0] === 'ls-tree' ? CATALOG_PATH : JSON.stringify(entry('older'));
  const base = readBaseCatalog(root, sha, present);
  expect(() => checkDebtSubset([entry('newer')], base)).toThrow('must only shrink');
  expect(() =>
    readBaseCatalog(root, sha, args =>
      args[0] === 'rev-parse' ? sha : args[0] === 'ls-tree' ? CATALOG_PATH : '{invalid'
    )
  ).toThrow();
});

it('prefers the PR base, uses push before, and falls back to origin/main locally', () => {
  expect(
    eventBase({ GITHUB_EVENT_PATH: 'event' }, () =>
      JSON.stringify({ pull_request: { base: { sha: 'pr-base' } }, before: 'push-base' })
    )
  ).toBe('pr-base');
  expect(eventBase({ GITHUB_EVENT_PATH: 'event' }, () => JSON.stringify({ before: 'push-base' }))).toBe('push-base');
  expect(eventBase({})).toBe('origin/main');
  expect(eventBase({ GITHUB_EVENT_PATH: 'event' }, () => JSON.stringify({ before: '0'.repeat(40) }))).toBe(
    'origin/main'
  );
});

it('parses reasoned catalog entries without counting comments', () => {
  expect(parseCatalog(`# inventory\n\n${JSON.stringify(entry('one'))}\n`)).toEqual([entry('one')]);
});

describe('mandatory full-history CI gate', () => {
  const workflow = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8');
  const job = workflow.slice(workflow.indexOf('\n  repo-guards:'), workflow.indexOf('\n  secret-scan:'));
  const gate = readFileSync(resolve(root, 'scripts/check-contract-gate.sh'), 'utf8');
  const filter = readFileSync(resolve(root, '.github/actions/changes-filter/action.yml'), 'utf8');
  const exclusions = filter
    .slice(filter.indexOf('  exclude-paths:'), filter.indexOf('  content-paths:'))
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.startsWith(':(exclude'));

  it('runs the inventory check from the existing blocking full-history job', () => {
    expect(job).toContain("if: needs.changes.outputs.deployable == 'true'");
    expect(job).toContain('fetch-depth: 0');
    expect(job).toContain('run: bash scripts/check-contract-gate.sh');
    expect(job).toMatch(/^ {8}run: node scripts\/check-provider-call-inventory\.mjs$/m);
    expect(gate).not.toContain('check-provider-call-inventory.mjs');
    expect(gate).toContain('set -euo pipefail');
  });

  it.each([
    'apps/client/server/utils/resolveImagePrompt.ts',
    'apps/workers/src/queueHandlers/questExport.ts',
    'b4m-core/services/src/countersService/agnosticAiInsights.ts',
    'packages/server-utils/src/utils/telemetryAnalysis.ts',
  ])('treats %s as deployable so repo-guards cannot be skipped', file => {
    const selected = execFileSync('git', ['ls-files', '--', '.', ...exclusions], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    })
      .trim()
      .split('\n');
    expect(selected).toContain(file);
  });
});
