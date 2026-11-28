import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { affectedPackages, planAffected, planShard, resolveFilter } from '../ci-affected-tests.mjs';
import { planClientRelated, conservativeSeeds } from '../ci-related-tests.mjs';
import { WHOLE_REPO_TEST_PACKAGES } from '../turbo-test-cache.mjs';
import { readPackageDirs, readTurboJson } from '../verify-affected.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ci = fs.readFileSync(path.join(repoRoot, '.github/workflows/ci.yml'), 'utf8');
const turbo = readTurboJson();
const packageDirs = readPackageDirs();
const workspace = Object.keys(packageDirs).sort();

// The test-shards matrix legs, by name, with their declared filters (YAML's outer quotes stripped).
function readLegs() {
  const matrix = ci.slice(ci.indexOf('  test-shards:'), ci.indexOf('\n    steps:', ci.indexOf('  test-shards:')));
  return matrix
    .split(/^\s*- name:/m)
    .slice(1)
    .map(block => {
      const read = key => /^'(.*)'$/.exec(new RegExp(`^\\s*${key}:\\s*(\\S.*?)\\s*$`, 'm').exec(block)?.[1] ?? "''")[1];
      return {
        name: block.split('\n')[0].trim(),
        filter: read('filter'),
        integrationFilter: read('integration-filter'),
        alwaysSetup: block.split('\n')[0].trim() === 'misc' || /^\s*typecheck:\s*'true'/m.test(block),
      };
    });
}

// The whole pipeline a PR run takes: changed files -> core-build's plan -> each leg's filters.
function legsFor(changedFiles) {
  const planned = planAffected({ changedFiles, turbo, packageDirs });
  const plan = planned.full
    ? { full: true }
    : { full: false, workspace, packages: affectedPackages(planned.selection, workspace) };
  return Object.fromEntries(readLegs().map(leg => [leg.name, planShard({ plan, ...leg, unitFilter: leg.filter })]));
}

const clientLegs = ['client 1/3', 'client 2/3', 'client 3/3'];

describe('test-shards selection for a PR diff (real turbo graph and ci.yml)', () => {
  it.each([
    'apps/workers/src/services/newProvider.ts',
    'b4m-core/services/src/newProvider.ts',
    'packages/server-utils/src/newProvider.ts',
    'scripts/unmetered-provider-call-allowlist.txt',
  ])('selects the client guard and full client lane for foreign input %s', file => {
    const legs = legsFor([file]);
    for (const name of clientLegs) expect(legs[name].unitFilter).toBe('--filter @bike4mind/client');
    expect(planClientRelated([file], true)).toEqual({ mode: 'full' });
  });

  it('seeds the filesystem-reading provider guard for client-only related selection', () => {
    const file = 'apps/client/server/__tests__/aiRoutesMeterPlatformCompletions.test.ts';
    expect(conservativeSeeds([file], name => fs.readFileSync(path.join(repoRoot, name), 'utf8'))).toEqual([file]);
  });

  it('reads every leg of the matrix', () => {
    expect(readLegs().map(leg => leg.name)).toEqual(expect.arrayContaining([...clientLegs, 'misc']));
  });

  it('skips every client leg and the client integration lane for a desktop-only diff', () => {
    const legs = legsFor(['apps/desktop/src/main/index.ts']);
    for (const name of clientLegs) expect(legs[name], name).toMatchObject({ unitFilter: '', setup: false });
    expect(legs['client-integration'].integrationFilter).toBe('');
    expect(legs.desktop.unitFilter).toBe('--filter @bike4mind/desktop');
  });

  it('runs the client legs and workers (which reads apps/client) for a client server change', () => {
    const legs = legsFor(['apps/client/server/utils/foo.ts']);
    for (const name of clientLegs) expect(legs[name].unitFilter, name).toBe('--filter @bike4mind/client');
    expect(legs['client-integration'].integrationFilter).toBe('--filter @bike4mind/client');
    expect(legs['cli-workers'].unitFilter).toContain('--filter @bike4mind/workers');
  });

  it('runs every dependent of b4m-core/common', () => {
    const dependents = Object.keys(readPackageDirs(['--filter=...@bike4mind/common']));
    expect(dependents).toEqual(expect.arrayContaining(['@bike4mind/common', '@bike4mind/client', '@bike4mind/cli']));
    const legs = legsFor(['b4m-core/common/src/index.ts']);
    const selected = Object.values(legs).flatMap(leg =>
      `${leg.unitFilter} ${leg.integrationFilter}`.split(/\s+/).filter(token => token && token !== '--filter')
    );
    for (const name of dependents) expect(selected, name).toContain(name);
  });

  it('always tests the whole-repo packages, whose suites read outside their inputs', () => {
    const legs = legsFor(['README.md']);
    const selected = Object.values(legs)
      .map(leg => `${leg.unitFilter} ${leg.integrationFilter}`)
      .join(' ');
    for (const name of WHOLE_REPO_TEST_PACKAGES.filter(name => workspace.includes(name))) {
      expect(selected, name).toContain(`--filter ${name}`);
    }
    for (const name of clientLegs) expect(legs[name].setup, name).toBe(false);
  });

  it('skips isolated ordinary suites for unrelated docs while keeping the uncached misc leg', () => {
    const legs = legsFor(['README.md']);
    const selected = Object.values(legs)
      .map(leg => `${leg.unitFilter} ${leg.integrationFilter}`)
      .join(' ');
    for (const name of ['database', 'infra', 'resource', 'server-utils', 'services-core', 'workers']) {
      expect(selected).not.toContain(`--filter @bike4mind/${name}`);
    }
    expect(legs.misc.setup).toBe(true);
  });

  it.each([
    ['elasticmq.conf', '@bike4mind/resource'],
    ['selfhost/env-additions.txt', '@bike4mind/resource'],
    ['infra/buckets.ts', '@bike4mind/infra'],
    ['infra/analyticsRollup.ts', '@bike4mind/workers'],
    ['infra/alarms.ts', '@bike4mind/services-core'],
    ['catalog/model-hub/curated-v2.json', '@bike4mind/server-utils'],
    ['packages/server-utils/src/auth/ability.ts', '@bike4mind/database'],
    [
      'packages/scripts/migrate/migrations/20261118164439_ensure-email-triage-section-pending-index.ts',
      '@bike4mind/workers',
    ],
    [
      'packages/scripts/migrate/migrations/20261114125931_ensure-organization-export-erasure-index.ts',
      '@bike4mind/workers',
    ],
    ['packages/scripts/seeders/example.ts', '@bike4mind/workers'],
    ['packages/scripts/utils/config.ts', '@bike4mind/workers'],
    ['.changeset/changelog-github-retry.cjs', '@bike4mind/infra'],
    ['.changeset/config.json', '@bike4mind/infra'],
  ])('selects the bounded reader of %s', (file, name) => {
    const planned = planAffected({ changedFiles: [file], turbo, packageDirs });
    expect(planned.full).toBe(false);
    expect(affectedPackages(planned.selection, workspace)).toContain(name);
  });

  it.each([
    ['pnpm-lock.yaml'],
    ['turbo.json'],
    ['vitest.shared.ts'],
    ['.github/workflows/ci.yml'],
    ['scripts/ci-affected-tests.mjs'],
  ])('runs every leg in full for %s', file => {
    for (const leg of readLegs()) {
      expect(legsFor([file])[leg.name], leg.name).toMatchObject({
        unitFilter: leg.filter,
        integrationFilter: leg.integrationFilter,
        setup: true,
      });
    }
  });

  it('declares no leg filter that matches nothing', () => {
    for (const leg of readLegs()) {
      expect(resolveFilter(leg.filter, workspace), leg.name).not.toEqual([]);
      if (leg.integrationFilter) expect(resolveFilter(leg.integrationFilter, workspace), leg.name).not.toEqual([]);
    }
  });
});

describe('planAffected', () => {
  it('runs everything without a changed-file list', () => {
    expect(planAffected({ changedFiles: null, turbo, packageDirs }).full).toBe(true);
  });
});

describe('resolveFilter', () => {
  const ws = ['@b/a', '@b/b', '@b/c'];

  it('reads include lists and exclusion-only catch-alls', () => {
    expect(resolveFilter('--filter @b/a --filter @b/x', ws)).toEqual(['@b/a']);
    expect(resolveFilter('--filter !@b/a --filter !@b/b', ws)).toEqual(['@b/c']);
  });

  it('rejects quoted, unpaired or non-package tokens', () => {
    expect(() => resolveFilter("--filter '@b/a'", ws)).toThrow();
    expect(() => resolveFilter('--filter', ws)).toThrow(/unpaired/);
    expect(() => resolveFilter('--filter ...@b/a', ws)).toThrow();
  });
});

describe('planShard', () => {
  const plan = { full: false, workspace: ['@b/a', '@b/b', '@b/c'], packages: ['@b/b'] };

  it('keeps the declared filters for a full or missing plan', () => {
    for (const p of [{ full: true }, null]) {
      expect(planShard({ plan: p, unitFilter: '--filter @b/a', integrationFilter: '' })).toMatchObject({
        unitFilter: '--filter @b/a',
        integrationFilter: '',
        setup: true,
      });
    }
  });

  it('narrows both lanes to the affected packages', () => {
    expect(
      planShard({ plan, unitFilter: '--filter !@b/a', integrationFilter: '--filter @b/a --filter @b/b' })
    ).toMatchObject({ unitFilter: '--filter @b/b', integrationFilter: '--filter @b/b', setup: true });
  });

  it('skips setup when nothing is affected, unless the leg always runs', () => {
    expect(planShard({ plan, unitFilter: '--filter @b/a' })).toMatchObject({ unitFilter: '', setup: false });
    expect(planShard({ plan, unitFilter: '--filter @b/a', alwaysSetup: true }).setup).toBe(true);
  });

  it('reports a declared filter that matches no package, even when the leg skips', () => {
    expect(planShard({ plan, unitFilter: '--filter @b/typo' }).emptyLanes).toEqual(['unit']);
  });
});

describe('ci.yml test-shards gating', () => {
  const job = ci.slice(ci.indexOf('  test-shards:'), ci.indexOf('\n  test:\n'));
  const step = name => {
    const start = job.indexOf(`- name: ${name}`);
    expect(start, `step ${name} not found`).toBeGreaterThan(-1);
    return job.slice(start, job.indexOf('\n      - name:', start + 1));
  };

  it('selects before any setup', () => {
    expect(job.indexOf('- name: Select affected packages')).toBeLessThan(job.indexOf('- name: Setup pnpm'));
    expect(step('Select affected packages')).toContain('AFFECTED: ${{ needs.core-build.outputs.affected }}');
  });

  it.each([
    'Setup pnpm',
    'Cache pnpm dependencies',
    'Install dependencies',
    'Download core build artifacts',
    'Run premium glue codegen',
  ])('gates %s on the selection', name => expect(step(name)).toMatch(/if: steps\.select\.outputs\.setup == 'true'/));

  it('runs turbo on the selected filters and guards on the declared ones', () => {
    for (const [name, output] of [
      ['Run Tests (', 'unit-filter'],
      ['Run integration lane (', 'integration-filter'],
    ]) {
      const body = step(name);
      expect(body).toContain(`SELECTED_FILTER: \${{ steps.select.outputs.${output} }}`);
      expect(body).toContain('read -ra filter_args <<< "$SELECTED_FILTER"');
      expect(body).toContain('pnpm --recursive "${shard_filter_args[@]}" ls');
    }
  });
});
