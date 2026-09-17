import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isPlainNameKey, storeDirPackageName, collectEdges, findViolations } from '../check-pnpm-overrides.mjs';

// collectEdges runs against a throwaway virtual store built under the OS temp dir, so the
// assertions cover the shipped walker rather than a reimplementation. pnpm symlinks the
// dependency directories; plain directories read identically.

const stores = [];

afterEach(() => {
  while (stores.length) fs.rmSync(stores.pop(), { recursive: true, force: true });
});

function makeStore(packages) {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'pnpm-overrides-'));
  stores.push(store);

  for (const [dir, { manifest, installed = {} }] of Object.entries(packages)) {
    const depsRoot = path.join(store, dir, 'node_modules');
    write(path.join(depsRoot, ...manifest.name.split('/')), manifest);
    for (const [name, version] of Object.entries(installed)) {
      write(path.join(depsRoot, ...name.split('/')), { name, version });
    }
  }

  return store;
}

function write(dir, manifest) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest));
}

describe('isPlainNameKey', () => {
  it.each(['esbuild', '@smithy/core', '@grpc/grpc-js'])('accepts the plain name %s', key => {
    expect(isPlainNameKey(key)).toBe(true);
  });

  it.each(['axios@<1.18.0', '@babel/core@<7.29.6', 'postcss@>=8.0.0 <9.0.0', 'nanoid@<4.0.0'])(
    'rejects the selector %s',
    key => {
      expect(isPlainNameKey(key)).toBe(false);
    }
  );
});

describe('storeDirPackageName', () => {
  it.each([
    ['esbuild@0.28.1', 'esbuild'],
    ['@smithy+core@3.29.0', '@smithy/core'],
    ['vite@5.0.0(@types+node@20.0.0)', 'vite'],
    ['@mui+joy@5.0.0-beta.52(patch_hash=abc123)', '@mui/joy'],
  ])('reads %s as %s', (dir, expected) => {
    expect(storeDirPackageName(dir)).toBe(expected);
  });

  it('returns null for a directory with no version', () => {
    expect(storeDirPackageName('node_modules')).toBeNull();
  });
});

describe('collectEdges', () => {
  it('records what a dependent declared and what it actually resolved to', () => {
    const store = makeStore({
      'dependent@1.0.0': {
        manifest: { name: 'dependent', version: '1.0.0', dependencies: { '@smithy/core': '^3.33.3' } },
        installed: { '@smithy/core': '3.29.0' },
      },
    });

    expect(collectEdges(store, ['@smithy/core'])).toEqual([
      { dependent: 'dependent@1.0.0', dep: '@smithy/core', range: '^3.33.3', resolved: '3.29.0' },
    ]);
  });

  it('ignores dependencies that no override pins', () => {
    const store = makeStore({
      'dependent@1.0.0': {
        manifest: { name: 'dependent', version: '1.0.0', dependencies: { lodash: '^4.0.0' } },
        installed: { lodash: '3.0.0' },
      },
    });

    expect(collectEdges(store, ['@smithy/core'])).toEqual([]);
  });

  it('skips specs that are not semver ranges', () => {
    const store = makeStore({
      'dependent@1.0.0': {
        manifest: {
          name: 'dependent',
          version: '1.0.0',
          dependencies: { esbuild: 'workspace:*', 'esbuild-wasm': 'npm:esbuild@0.28.1' },
        },
        installed: { esbuild: '0.28.1', 'esbuild-wasm': '0.28.1' },
      },
    });

    expect(collectEdges(store, ['esbuild', 'esbuild-wasm'])).toEqual([]);
  });

  it('skips a dependency that is declared but not materialized', () => {
    const store = makeStore({
      'dependent@1.0.0': {
        manifest: { name: 'dependent', version: '1.0.0', dependencies: { '@smithy/core': '^3.33.3' } },
      },
    });

    expect(collectEdges(store, ['@smithy/core'])).toEqual([]);
  });
});

describe('findViolations', () => {
  it('passes when every edge resolved inside its declared range', () => {
    const edges = [
      { dependent: 'a@1.0.0', dep: '@smithy/core', range: '^3.33.3', resolved: '3.34.1' },
      { dependent: 'b@2.0.0', dep: '@smithy/core', range: '^3.29.1', resolved: '3.34.1' },
    ];

    expect(findViolations(edges).size).toBe(0);
  });

  it('flags an edge that resolved below its declared floor', () => {
    const edges = [{ dependent: 'a@1.0.0', dep: '@smithy/core', range: '^3.33.3', resolved: '3.29.0' }];
    const violations = findViolations(edges);

    expect([...violations.keys()]).toEqual(['@smithy/core']);
    const group = violations.get('@smithy/core').get('^3.33.3');
    expect(group.dependents).toEqual(['a@1.0.0']);
    expect([...group.resolved]).toEqual(['3.29.0']);
  });

  // An override written as a range leaves several versions in the tree, so a name-level
  // check would clear the whole package off the copy that happens to satisfy the range.
  it('flags only the failing edge when the tree holds several versions', () => {
    const edges = [
      { dependent: 'new-dependent@2.0.0', dep: '@xmldom/xmldom', range: '^0.8.15', resolved: '0.8.15' },
      { dependent: 'old-dependent@1.0.0', dep: '@xmldom/xmldom', range: '^0.8.15', resolved: '0.8.13' },
    ];

    const group = findViolations(edges).get('@xmldom/xmldom').get('^0.8.15');
    expect(group.dependents).toEqual(['old-dependent@1.0.0']);
  });

  it('groups every dependent that declared the same unsatisfied range', () => {
    const edges = [
      { dependent: 'a@1.0.0', dep: '@smithy/types', range: '^4.18.0', resolved: '4.15.1' },
      { dependent: 'b@1.0.0', dep: '@smithy/types', range: '^4.18.0', resolved: '4.15.1' },
      { dependent: 'c@1.0.0', dep: '@smithy/types', range: '^4.16.1', resolved: '4.15.1' },
    ];

    const byRange = findViolations(edges).get('@smithy/types');
    expect([...byRange.keys()].sort()).toEqual(['^4.16.1', '^4.18.0']);
    expect(byRange.get('^4.18.0').dependents).toEqual(['a@1.0.0', 'b@1.0.0']);
  });
});
