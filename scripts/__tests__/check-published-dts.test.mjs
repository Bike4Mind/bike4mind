import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  checkExitCode,
  discoverPackages,
  domLibFiles,
  entryImports,
  exportSubpaths,
  failedResults,
  fixtureDeclarations,
  groupTscErrors,
  nonTarballResolutions,
  run,
  selfTestVerdict,
  splitTscOutput,
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
    expect(selfTestVerdict(2, noDocument)).toBe(`self-test failed without naming ns$1 in index.d.mts\n${noDocument}`);
  });

  it('rejects a fixture that type-checks, since lib checking is then not active', () => {
    expect(selfTestVerdict(0, '')).toBe('self-test passed unexpectedly: lib checking is not active');
  });

  it('rejects a failure that does not name ns$1 and keeps the output for diagnosis', () => {
    const output = "error TS2307: Cannot find module '@bike4mind-fixture/dangling'.";
    expect(selfTestVerdict(2, output)).toBe(`self-test failed without naming ns$1 in index.d.mts\n${output}`);
  });

  describe('nodenext, where both fixture declarations must be named', () => {
    const declarations = ['index.d.mts', 'index.d.cts'];
    const cts = dangling.replace('index.d.mts', 'index.d.cts');

    it('is fine when the .mts and .cts entries both name ns$1', () => {
      expect(selfTestVerdict(2, `${dangling}\n${cts}\n${noDocument}`, declarations)).toBeNull();
    });

    it('rejects output where only the .mts entry names ns$1 and the .cts entry fails for another reason', () => {
      const ctsOther =
        "node_modules/@bike4mind-fixture/dangling/index.d.cts(2,17): error TS2307: Cannot find module 'x'.";
      expect(selfTestVerdict(2, `${dangling}\n${ctsOther}\n${noDocument}`, declarations)).toMatch(
        /^self-test failed without naming ns\$1 in index\.d\.cts/
      );
    });
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

describe('checkExitCode', () => {
  it('is 0 when every tsc run exits 0', () => {
    expect(checkExitCode([{ status: 0 }, { status: 0 }])).toBe(0);
  });

  it('is 1 for any non-zero status, and for a null status from a killed tsc', () => {
    expect(checkExitCode([{ status: 0 }, { status: 2 }])).toBe(1);
    expect(checkExitCode([{ status: null }, { status: 0 }])).toBe(1);
  });
});

describe('failedResults', () => {
  it('returns every result whose status is not 0, null included', () => {
    const bad = [{ status: 2 }, { status: null }];
    expect(failedResults([{ status: 0 }, ...bad])).toEqual(bad);
    expect(failedResults([{ status: 0 }])).toEqual([]);
  });
});

describe('fixtureDeclarations', () => {
  it('maps each consumer entry to the fixture declaration it resolves to', () => {
    expect(fixtureDeclarations(['esm.mts'])).toEqual(['index.d.mts']);
    expect(fixtureDeclarations(['esm.mts', 'cjs.cts'])).toEqual(['index.d.mts', 'index.d.cts']);
  });
});

describe('splitTscOutput', () => {
  it('separates absolute-path listing lines from diagnostics', () => {
    const out = [
      "node_modules/@bike4mind/a/dist/index.d.mts(1,1): error TS2304: Cannot find name 'X'.",
      '  more detail',
      '/c/node_modules/typescript/lib/lib.es2022.d.ts',
      'C:\\c\\lib.dom.d.ts',
    ].join('\n');
    const { listing, diagnostics } = splitTscOutput(out);
    expect(listing).toBe('/c/node_modules/typescript/lib/lib.es2022.d.ts\nC:\\c\\lib.dom.d.ts');
    expect(diagnostics).toBe(out.split('\n').slice(0, 2).join('\n'));
  });
});

describe('domLibFiles', () => {
  it('finds lib.dom.d.ts and lib.dom.iterable.d.ts in a file listing', () => {
    const listing = [
      '/c/node_modules/typescript/lib/lib.es2022.d.ts',
      '/c/node_modules/typescript/lib/lib.dom.d.ts',
      '/c/node_modules/typescript/lib/lib.dom.iterable.d.ts',
    ].join('\n');
    expect(domLibFiles(listing)).toEqual([
      '/c/node_modules/typescript/lib/lib.dom.d.ts',
      '/c/node_modules/typescript/lib/lib.dom.iterable.d.ts',
    ]);
  });

  it('finds webworker and dom.asynciterable libs', () => {
    const listing = [
      '/c/lib/lib.webworker.d.ts',
      '/c/lib/lib.webworker.importscripts.d.ts',
      '/c/lib/lib.dom.asynciterable.d.ts',
    ].join('\n');
    expect(domLibFiles(listing)).toHaveLength(3);
  });

  it('returns nothing for a DOM-free listing', () => {
    expect(
      domLibFiles('/c/node_modules/typescript/lib/lib.es2022.d.ts\n/c/node_modules/@types/node/index.d.ts')
    ).toEqual([]);
  });
});

describe('discoverPackages', () => {
  const common = { manifest: { name: '@bike4mind/common', version: '1.0.0' }, built: true };
  const roots = {};

  function makeRoot(packages) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'discover-packages-'));
    for (const [dir, { manifest, built }] of Object.entries(packages)) {
      fs.mkdirSync(path.join(root, 'b4m-core', dir), { recursive: true });
      fs.writeFileSync(path.join(root, 'b4m-core', dir, 'package.json'), JSON.stringify(manifest));
      if (built) fs.mkdirSync(path.join(root, 'b4m-core', dir, 'dist'));
    }
    return root;
  }

  beforeAll(() => {
    roots.ok = makeRoot({
      common,
      internal: { manifest: { name: '@bike4mind/internal', version: '1.0.0', private: true }, built: false },
    });
    roots.unbuilt = makeRoot({
      common,
      utils: { manifest: { name: '@bike4mind/utils', version: '1.0.0' }, built: false },
      agents: { manifest: { name: '@bike4mind/agents', version: '1.0.0' }, built: false },
    });
  });

  afterAll(() => Object.values(roots).forEach(root => fs.rmSync(root, { recursive: true, force: true })));

  it('skips private manifests and returns the built published ones', () => {
    expect(discoverPackages(roots.ok).map(pkg => pkg.packageName)).toEqual(['@bike4mind/common']);
  });

  it('names every published package that has no dist', () => {
    expect(() => discoverPackages(roots.unbuilt)).toThrow(
      'no dist/ in b4m-core/{agents,utils}; run pnpm turbo:core:build first'
    );
  });
});
