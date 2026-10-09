import { describe, it, expect } from 'vitest';
import {
  entryImports,
  exportSubpaths,
  groupTscErrors,
  lockfileVersion,
  nonTarballResolutions,
  run,
  selfTestVerdict,
} from '../check-published-dts.mjs';

const dual = stem => ({
  import: { types: `./dist/${stem}.d.mts`, default: `./dist/${stem}.mjs` },
  require: { types: `./dist/${stem}.d.cts`, default: `./dist/${stem}.cjs` },
});

describe('exportSubpaths', () => {
  it('lists every subpath of the dual import/require shape the b4m-core packages use', () => {
    expect(exportSubpaths({ '.': dual('index'), './llm/backend': dual('llm/backend') })).toEqual([
      '.',
      './llm/backend',
    ]);
  });

  it('skips package.json and wildcard subpaths', () => {
    expect(
      exportSubpaths({
        '.': dual('index'),
        './package.json': './package.json',
        './*': './dist/*.mjs',
        './features/*': dual('f'),
      })
    ).toEqual(['.']);
  });

  it('keeps a string target only when it is a declaration file', () => {
    expect(exportSubpaths({ './a': './dist/a.d.mts', './b': './dist/b.mjs', './c': './dist/c.json' })).toEqual(['./a']);
  });

  it('finds a flat types condition and a types condition inside an array fallback', () => {
    expect(
      exportSubpaths({ '.': { types: './x.d.ts', default: './x.js' }, './arr': [{ types: './y.d.ts' }, './y.js'] })
    ).toEqual(['.', './arr']);
  });

  it('treats a bare string, array or condition object as the root subpath', () => {
    expect(exportSubpaths('./dist/index.d.mts')).toEqual(['.']);
    expect(exportSubpaths([{ types: './i.d.ts' }])).toEqual(['.']);
    expect(exportSubpaths({ import: { types: './i.d.mts' }, require: { types: './i.d.cts' } })).toEqual(['.']);
  });

  it('returns nothing for a missing exports field, a null target or a wildcard-only map', () => {
    expect(exportSubpaths(undefined)).toEqual([]);
    expect(exportSubpaths({ './internal': null })).toEqual([]);
    expect(exportSubpaths({ './*': { types: './dist/*.d.mts' } })).toEqual([]);
  });
});

describe('groupTscErrors', () => {
  const services =
    "node_modules/@bike4mind/services/dist/index.d.mts(12851,4043): error TS2552: Cannot find name 'index_d_exports$22'.";
  const utils =
    "node_modules/@bike4mind/utils/dist/backend-CC8koS3r.d.cts(3,10): error TS2304: Cannot find name '__exportAll'.";

  it('groups errors by the @bike4mind package whose dist they point into', () => {
    const groups = groupTscErrors([services, utils, 'Found 2 errors in 2 files.'].join('\n'));
    expect([...groups.keys()]).toEqual(['@bike4mind/services', '@bike4mind/utils']);
    expect([...groups.get('@bike4mind/services')]).toEqual([services]);
  });

  it('collapses the same error reported by both configs and keeps continuation lines with their error', () => {
    const detailed = `${services}\n  The expected type comes from property 'x'`;
    const groups = groupTscErrors([detailed, utils, detailed].join('\n'));
    expect([...groups.get('@bike4mind/services')]).toEqual([detailed]);
  });

  it('files errors outside @bike4mind dist under their own group instead of dropping them', () => {
    const groups = groupTscErrors(
      "node_modules/zod/v4/index.d.ts(1,1): error TS2307: Cannot find module 'x'.\nerror TS5110: bad option"
    );
    expect([...groups.keys()]).toEqual(['other (not a @bike4mind package)']);
    expect(groups.get('other (not a @bike4mind package)').size).toBe(2);
  });

  it('returns no groups for output without errors', () => {
    expect(groupTscErrors('').size).toBe(0);
  });
});

describe('lockfileVersion', () => {
  const lock = [
    "lockfileVersion: '9.0'",
    '',
    'importers:',
    '',
    '  .:',
    '    dependencies:',
    '      sst:',
    '        specifier: 4.17.1',
    '        version: 4.17.1',
    '    devDependencies:',
    "      '@types/node':",
    '        specifier: ^24.0.0',
    '        version: 24.12.3',
    '      vitest:',
    '        specifier: ^4.1.11',
    '        version: 4.1.11(@opentelemetry/api@1.9.0)(@types/node@24.12.3)(jsdom@29.1.1(canvas@3.2.1))',
    '',
    '  apps/client:',
    '    devDependencies:',
    "      '@types/node':",
    '        specifier: ^24.0.0',
    '        version: 24.1.0',
    '',
    'packages:',
    '',
    "  '@types/node@24.12.3':",
    '    resolution: {integrity: sha512-x}',
    '',
  ].join('\n');

  it('reads a plain version, quoted or not', () => {
    expect(lockfileVersion(lock, '.', '@types/node')).toBe('24.12.3');
    expect(lockfileVersion(lock, '.', 'sst')).toBe('4.17.1');
  });

  it('strips a parenthesised peer suffix', () => {
    expect(lockfileVersion(lock, '.', 'vitest')).toBe('4.1.11');
  });

  it('reads the requested importer only', () => {
    expect(lockfileVersion(lock, 'apps/client', '@types/node')).toBe('24.1.0');
  });

  it('names the dependency and importer when the entry is missing', () => {
    expect(() => lockfileVersion(lock, '.', 'typescript')).toThrow(
      'cannot find typescript in the "." importer of pnpm-lock.yaml'
    );
    expect(() => lockfileVersion(lock, 'apps/missing', 'sst')).toThrow(/"apps\/missing" importer/);
  });

  it('does not read a package entry outside the importers section', () => {
    expect(() => lockfileVersion('packages:\n  .:\n      sst:\n        version: 1.0.0\n', '.', 'sst')).toThrow(
      /cannot find sst/
    );
  });
});

describe('run', () => {
  it('returns stdout on success', () => {
    expect(run(process.execPath, ['-e', "process.stdout.write('ok')"])).toBe('ok');
  });

  it('surfaces the command stderr when it exits non-zero', () => {
    expect(() => run(process.execPath, ['-e', "console.error('npm ERR! ERESOLVE'); process.exit(3)"])).toThrow(
      /failed \(exit 3\)[\s\S]*ERESOLVE/
    );
  });
});

describe('nonTarballResolutions', () => {
  const packed = ['@bike4mind/common', '@bike4mind/utils'];
  const tarball = { version: '1.0.0', resolved: 'file:../tarballs/bike4mind-common-1.0.0.tgz' };

  it('accepts packed packages resolved from a local tarball', () => {
    expect(
      nonTarballResolutions(
        { '': {}, 'node_modules/@bike4mind/common': tarball, 'node_modules/@bike4mind/utils': tarball },
        packed
      )
    ).toEqual([]);
  });

  it('names the package and where npm fetched it from instead', () => {
    expect(
      nonTarballResolutions(
        {
          'node_modules/@bike4mind/common': tarball,
          'node_modules/@bike4mind/utils': {
            resolved: 'https://registry.npmjs.org/@bike4mind/utils/-/utils-1.0.0.tgz',
          },
        },
        packed
      )
    ).toEqual([
      'npm resolved @bike4mind/utils from https://registry.npmjs.org/@bike4mind/utils/-/utils-1.0.0.tgz, not the packed tarball',
    ]);
  });

  it('also rejects a nested registry copy under another package', () => {
    const nested = 'node_modules/@bike4mind/utils/node_modules/@bike4mind/common';
    expect(nonTarballResolutions({ [nested]: { resolved: 'https://registry.npmjs.org/x.tgz' } }, packed)).toHaveLength(
      1
    );
  });

  it('reports an entry without a resolved field and ignores unpacked or unrelated packages', () => {
    expect(nonTarballResolutions({ 'node_modules/@bike4mind/common': {} }, packed)).toEqual([
      'npm resolved @bike4mind/common from (no resolved field), not the packed tarball',
    ]);
    expect(
      nonTarballResolutions(
        {
          'node_modules/@bike4mind/other': { resolved: 'https://registry.npmjs.org/o.tgz' },
          'node_modules/zod': { resolved: 'https://registry.npmjs.org/zod.tgz' },
        },
        packed
      )
    ).toEqual([]);
  });
});

describe('selfTestVerdict', () => {
  const dangling =
    "node_modules/@bike4mind-fixture/dangling/index.d.mts(2,17): error TS2503: Cannot find namespace 'ns$1'.";
  const noDocument =
    "node_modules/@bike4mind-fixture/dangling/index.d.mts(4,17): error TS2304: Cannot find name 'Document'.";
  const named = `${dangling}\n${noDocument}`;

  it('is fine when the fixture fails for the dangling name and for the missing DOM Document', () => {
    expect(selfTestVerdict(2, named)).toBeNull();
  });

  it('rejects a consumer where DOM types are present, since DOM leaks from our packages would pass', () => {
    expect(selfTestVerdict(2, dangling)).toBe(
      'self-test: DOM types are present in the consumer (lib or a /// <reference lib="dom"> leaked them in); DOM leaks from our packages would pass'
    );
  });

  it('checks the dangling name before the DOM canary', () => {
    expect(selfTestVerdict(2, noDocument)).toBe(`self-test failed without naming ns$1\n${noDocument}`);
  });

  it('rejects a fixture that type-checks, since lib checking is then not active', () => {
    expect(selfTestVerdict(0, '')).toBe('self-test passed unexpectedly: lib checking is not active');
  });

  it('rejects a failure that does not name ns$1 and keeps the output for diagnosis', () => {
    const output = "error TS2307: Cannot find module '@bike4mind-fixture/dangling'.";
    expect(selfTestVerdict(2, output)).toBe(`self-test failed without naming ns$1\n${output}`);
  });

  it('treats a killed tsc (null status) as a failure for the wrong reason', () => {
    expect(selfTestVerdict(null, 'tsc killed by SIGKILL\n')).toMatch(/^self-test failed without naming ns\$1/);
  });
});

describe('entryImports', () => {
  const typed = { name: '@bike4mind/common', exports: { '.': dual('index'), './llm': dual('llm') } };

  it('lists one specifier per importable subpath', () => {
    expect(entryImports([typed])).toEqual(['@bike4mind/common', '@bike4mind/common/llm']);
  });

  it('throws naming every package that exposes no importable types export', () => {
    expect(() =>
      entryImports([typed, { name: '@bike4mind/bare' }, { name: '@bike4mind/js', exports: { '.': './dist/i.js' } }])
    ).toThrow(
      'no importable export resolves a types file in: @bike4mind/bare, @bike4mind/js; its declarations would go unchecked'
    );
  });
});
