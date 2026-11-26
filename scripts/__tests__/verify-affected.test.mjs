import { describe, expect, it } from 'vitest';
import {
  needsFullRun,
  packageOfFile,
  packagesReachedByForeignInputs,
  parseArgs,
  planLint,
  readTurboJson,
  resolveForeignInput,
  selectAffected,
  turboFilters,
} from '../verify-affected.mjs';

const turbo = readTurboJson();
const packageDirs = {
  '@bike4mind/client': 'apps/client',
  '@bike4mind/workers': 'apps/workers',
  '@bike4mind/scripts': 'packages/scripts',
  '@bike4mind/server-utils': 'packages/server-utils',
  '@bike4mind/infra': 'b4m-core/infra',
  '@bike4mind/common': 'b4m-core/common',
};
const reached = (changedFiles, tasks = ['typecheck', 'test']) =>
  [...packagesReachedByForeignInputs({ turbo, packageDirs, tasks, changedFiles })].sort();

describe('resolveForeignInput', () => {
  it('maps root-anchored and parent-relative inputs to repo paths', () => {
    expect(resolveForeignInput('$TURBO_ROOT$/infra/**', 'apps/client')).toBe('infra/**');
    expect(resolveForeignInput('../client/**/*.ts', 'apps/workers')).toBe('apps/client/**/*.ts');
    expect(resolveForeignInput('../../packages/server-utils/**', 'apps/client')).toBe('packages/server-utils/**');
  });

  it('ignores own-package, default and negated inputs', () => {
    expect(resolveForeignInput('src/**', 'apps/client')).toBeNull();
    expect(resolveForeignInput('$TURBO_DEFAULT$', 'apps/client')).toBeNull();
    expect(resolveForeignInput('!../server-utils/node_modules/**', 'packages/scripts')).toBeNull();
  });
});

describe('packagesReachedByForeignInputs (real turbo.json)', () => {
  it.each([
    'apps/workers/src/services/newProvider.ts',
    'b4m-core/services/src/newProvider.ts',
    'packages/server-utils/src/newProvider.ts',
    'scripts/unmetered-provider-call-allowlist.txt',
    'scripts/unmetered-llm-route-allowlist.txt',
  ])('runs and invalidates the client provider guard for %s', file => {
    expect(reached([file], ['test'])).toContain('@bike4mind/client');
    expect(reached([file], ['test:integration'])).toContain('@bike4mind/client');
  });

  it('runs workers when only apps/client source changed', () => {
    expect(reached(['apps/client/server/utils/foo.ts'])).toContain('@bike4mind/workers');
  });

  it('only follows edges of the requested tasks', () => {
    // server-utils#test reads apps/client/pages; its typecheck does not.
    expect(reached(['apps/client/pages/api/foo.ts'], ['test'])).toContain('@bike4mind/server-utils');
    expect(reached(['apps/client/pages/api/foo.ts'], ['typecheck'])).not.toContain('@bike4mind/server-utils');
  });

  it('adds nothing for a change no foreign input reaches', () => {
    expect(reached(['b4m-core/common/src/foo.ts'])).toEqual([]);
  });
});

describe('needsFullRun', () => {
  it('runs everything for root config and global dependencies', () => {
    expect(needsFullRun(['pnpm-lock.yaml'], turbo)).toBe(true);
    expect(needsFullRun(['turbo.json'], turbo)).toBe(true);
    expect(needsFullRun(['vitest.shared.ts'], turbo)).toBe(true);
  });

  it('leaves package changes to the filter', () => {
    expect(needsFullRun(['apps/client/package.json', 'b4m-core/common/src/a.ts'], turbo)).toBe(false);
  });
});

describe('selectAffected', () => {
  it('maps files to their deepest owning package', () => {
    const dirs = { '@b/premium': 'packages/premium/x', '@b/engine': 'packages/premium/x/engine' };
    expect(packageOfFile('packages/premium/x/engine/src/a.ts', dirs)).toBe('@b/engine');
    expect(packageOfFile('packages/premium/x/a.ts', dirs)).toBe('@b/premium');
    expect(packageOfFile('packages/premium/xy/a.ts', dirs)).toBeNull();
    expect(packageOfFile('docs-site/a.md', dirs)).toBeNull();
  });

  it('runs changed packages with dependents and foreign-input readers without', () => {
    const selection = selectAffected({
      changedFiles: ['apps/client/server/a.ts', 'docs-site/a.md'],
      turbo,
      packageDirs,
      tasks: ['test'],
    });
    expect(selection.changed).toEqual(['@bike4mind/client']);
    expect(selection.extra).toContain('@bike4mind/workers');
    expect(turboFilters(selection)).toEqual(
      expect.arrayContaining(['--filter=...@bike4mind/client', '--filter=@bike4mind/workers'])
    );
  });

  it('selects only the root package when no package file changed', () => {
    const selection = selectAffected({ changedFiles: ['docs-site/a.md'], turbo, packageDirs, tasks: ['test'] });
    expect(turboFilters(selection)).toEqual(['--filter=//']);
    expect(turboFilters({ changed: [], extra: [] })).toEqual([]);
  });

  it('runs everything for a lockfile change', () => {
    expect(selectAffected({ changedFiles: ['pnpm-lock.yaml'], turbo, packageDirs, tasks: ['test'] })).toEqual({
      full: true,
    });
  });
});

describe('planLint', () => {
  const exists = file => !file.includes('deleted');

  it('lints changed, existing source files only', () => {
    expect(planLint(['a/x.ts', 'a/y.md', 'a/deleted.ts', 'b/z.mjs'], exists)).toEqual({
      mode: 'files',
      files: ['a/x.ts', 'b/z.mjs'],
    });
  });

  it('falls back to a full lint when lint config changed', () => {
    expect(planLint(['eslint.config.mjs'], exists)).toEqual({ mode: 'full' });
    expect(planLint(['eslint-rules/no-raw-entity-response.mjs'], exists)).toEqual({ mode: 'full' });
    expect(planLint(['eslint-suppressions.json'], exists)).toEqual({ mode: 'full' });
  });

  it('falls back to a full lint when the root manifest or lockfile changed', () => {
    expect(planLint(['pnpm-lock.yaml'], exists)).toEqual({ mode: 'full' });
    expect(planLint(['package.json'], exists)).toEqual({ mode: 'full' });
    expect(planLint(['apps/client/package.json', 'apps/client/a.ts'], exists)).toEqual({
      mode: 'files',
      files: ['apps/client/a.ts'],
    });
  });

  it('skips when nothing lintable changed', () => {
    expect(planLint(['docs/a.md'], exists)).toEqual({ mode: 'skip' });
  });
});

describe('parseArgs', () => {
  it('passes unknown flags through to turbo', () => {
    expect(parseArgs(['--tasks', 'typecheck', '--no-lint', '--concurrency=4'])).toEqual({
      tasks: ['typecheck'],
      lint: false,
      dry: false,
      turboArgs: ['--concurrency=4'],
    });
  });

  it('rejects --tasks with no value', () => {
    expect(() => parseArgs(['--tasks'])).toThrow(/--tasks needs a value/);
  });
});
