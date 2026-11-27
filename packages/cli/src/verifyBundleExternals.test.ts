import { describe, it, expect } from 'vitest';
import {
  getPackageName,
  isExternalPackage,
  findUndeclaredBundleDeps,
  collectChunkImports,
  type EmittedBundle,
} from './verifyBundleExternals';

describe('getPackageName', () => {
  it('returns unscoped package names, stripping subpaths', () => {
    expect(getPackageName('tldts')).toBe('tldts');
    expect(getPackageName('lodash/range.js')).toBe('lodash');
    expect(getPackageName('csv-parse/sync')).toBe('csv-parse');
  });

  it('keeps the scope for scoped packages, stripping deeper subpaths', () => {
    expect(getPackageName('@aws-sdk/client-s3')).toBe('@aws-sdk/client-s3');
    expect(getPackageName('@modelcontextprotocol/sdk/client/stdio.js')).toBe('@modelcontextprotocol/sdk');
    expect(getPackageName('@opensearch-project/opensearch/aws-v3')).toBe('@opensearch-project/opensearch');
  });
});

describe('isExternalPackage', () => {
  it('accepts bare npm specifiers (with or without subpaths)', () => {
    expect(isExternalPackage('tldts')).toBe(true);
    expect(isExternalPackage('lodash/range.js')).toBe(true);
    expect(isExternalPackage('@aws-sdk/client-rekognition')).toBe(true);
  });

  it('rejects relative and absolute module ids (internal bundle modules)', () => {
    expect(isExternalPackage('./AgentHistoryStore.mjs')).toBe(false);
    expect(isExternalPackage('../utils/index.mjs')).toBe(false);
    expect(isExternalPackage('/Users/x/b4m-core/utils/dist/index.mjs')).toBe(false);
  });

  it('rejects scheme-prefixed specifiers and node built-ins', () => {
    expect(isExternalPackage('node:fs')).toBe(false);
    expect(isExternalPackage('node:dns/promises')).toBe(false);
    expect(isExternalPackage('data:text/javascript,foo')).toBe(false);
    expect(isExternalPackage('fs')).toBe(false);
    expect(isExternalPackage('path')).toBe(false);
    expect(isExternalPackage('child_process')).toBe(false);
  });

  it('rejects the inline-bundled @bike4mind/* scope', () => {
    expect(isExternalPackage('@bike4mind/utils')).toBe(false);
    expect(isExternalPackage('@bike4mind/services')).toBe(false);
  });
});

describe('collectChunkImports', () => {
  it('collects static and dynamic imports across chunks, skipping sibling chunks and assets', () => {
    const bundle: EmittedBundle = {
      'index.mjs': {
        type: 'chunk',
        code: 'import { x } from "./shared-abc.mjs";\nimport { parse } from "tldts";\nawait import("jimp");\n',
        imports: ['shared-abc.mjs', 'tldts'],
        dynamicImports: ['jimp'],
      },
      'shared-abc.mjs': { type: 'chunk', code: 'import axios from "axios";\n', imports: ['axios'] },
      'curated-build.json': { type: 'asset' },
    };
    expect([...collectChunkImports(bundle)].sort()).toEqual(['axios', 'jimp', 'tldts']);
  });

  it('drops an import the chunk lists but its rendered code no longer contains', () => {
    const bundle: EmittedBundle = {
      'index.mjs': {
        type: 'chunk',
        code: 'import axios from "axios";\n',
        imports: ['axios', '@google/genai'],
      },
    };
    expect([...collectChunkImports(bundle)]).toEqual(['axios']);
  });

  it('counts a backtick-quoted dynamic import, so an undeclared one still fails the guard', () => {
    const bundle: EmittedBundle = {
      'index.mjs': {
        type: 'chunk',
        code: 'async function load(){return import(`zz-undeclared`)}',
        dynamicImports: ['zz-undeclared'],
      },
    };
    expect([...collectChunkImports(bundle)]).toEqual(['zz-undeclared']);
    expect(findUndeclaredBundleDeps(collectChunkImports(bundle), new Set())).toEqual(['zz-undeclared']);
  });

  it('handles a minified-shape chunk mixing from"x" and import(`y`)', () => {
    const bundle: EmittedBundle = {
      'index.mjs': {
        type: 'chunk',
        code: 'import{a}from"x";export async function f(){return import(`y`)}',
        imports: ['x'],
        dynamicImports: ['y'],
      },
    };
    expect([...collectChunkImports(bundle)].sort()).toEqual(['x', 'y']);
  });

  it('feeds findUndeclaredBundleDeps end-to-end (the plugin path)', () => {
    const bundle: EmittedBundle = {
      'index.mjs': {
        type: 'chunk',
        code: 'import "tldts";\nimport fs from "node:fs";\nimport { y } from "./x.mjs";\nimport("jimp");\n',
        imports: ['tldts', 'node:fs', 'x.mjs'],
        dynamicImports: ['jimp'],
      },
      'x.mjs': { type: 'chunk', code: '' },
    };
    const missing = findUndeclaredBundleDeps(collectChunkImports(bundle), new Set(['tldts']));
    expect(missing).toEqual(['jimp']);
  });
});

describe('findUndeclaredBundleDeps', () => {
  it('flags external imports that are not declared dependencies', () => {
    const declared = new Set(['axios']);
    const specifiers = ['axios', 'tldts', 'jimp'];
    expect(findUndeclaredBundleDeps(specifiers, declared)).toEqual(['jimp', 'tldts']);
  });

  it('returns empty when every external is declared', () => {
    const declared = new Set(['tldts', 'jimp', '@aws-sdk/client-rekognition']);
    const specifiers = ['tldts', 'jimp', '@aws-sdk/client-rekognition'];
    expect(findUndeclaredBundleDeps(specifiers, declared)).toEqual([]);
  });

  it('validates a subpath import against its package root', () => {
    // write-excel-file/node is imported; declaring the package root is enough.
    expect(findUndeclaredBundleDeps(['write-excel-file/node'], new Set(['write-excel-file']))).toEqual([]);
    expect(findUndeclaredBundleDeps(['write-excel-file/node'], new Set())).toEqual(['write-excel-file']);
  });

  it('ignores internal modules, built-ins, schemes, and bundled @bike4mind/* scope', () => {
    const specifiers = ['/abs/internal.mjs', './relative.mjs', 'node:fs', 'fs', '@bike4mind/utils'];
    expect(findUndeclaredBundleDeps(specifiers, new Set())).toEqual([]);
  });

  it('de-duplicates and sorts the missing list', () => {
    const specifiers = ['tldts', 'tldts', 'jimp', 'jimp/plugin'];
    expect(findUndeclaredBundleDeps(specifiers, new Set())).toEqual(['jimp', 'tldts']);
  });
});
