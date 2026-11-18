import { describe, expect, it } from 'vitest';
import {
  needsFullRun,
  packagesReachedByForeignInputs,
  parseArgs,
  planLint,
  readTurboJson,
  resolveForeignInput,
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
const reached = (changedFiles, tasks = ['typecheck:fast', 'test']) =>
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
  it('runs workers when only apps/client source changed', () => {
    expect(reached(['apps/client/server/utils/foo.ts'])).toContain('@bike4mind/workers');
  });

  it('only follows edges of the requested tasks', () => {
    // server-utils#test reads apps/client/pages; its typecheck does not.
    expect(reached(['apps/client/pages/api/foo.ts'], ['test'])).toContain('@bike4mind/server-utils');
    expect(reached(['apps/client/pages/api/foo.ts'], ['typecheck:fast'])).not.toContain('@bike4mind/server-utils');
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

  it('skips when nothing lintable changed', () => {
    expect(planLint(['docs/a.md'], exists)).toEqual({ mode: 'skip' });
  });
});

describe('parseArgs', () => {
  it('passes unknown flags through to turbo', () => {
    expect(parseArgs(['--tasks', 'typecheck:fast', '--no-lint', '--concurrency=4'])).toEqual({
      tasks: ['typecheck:fast'],
      lint: false,
      dry: false,
      turboArgs: ['--concurrency=4'],
    });
  });

  it('rejects --tasks with no value', () => {
    expect(() => parseArgs(['--tasks'])).toThrow(/--tasks needs a value/);
  });
});
