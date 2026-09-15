import { describe, it, expect } from 'vitest';
import {
  getPackageName,
  isExternalPackage,
  findUndeclaredBundleDeps,
  collectGraphSpecifiers,
  type ModuleGraph,
} from './verifyBundleExternals';

/** Build a fake rolldown module graph from an id -> {static, dynamic} map. */
function fakeGraph(
  modules: Record<string, { importedIds?: string[]; dynamicallyImportedIds?: string[] }>
): ModuleGraph {
  return {
    getModuleIds: () => Object.keys(modules),
    getModuleInfo: id =>
      modules[id]
        ? {
            importedIds: modules[id].importedIds ?? [],
            dynamicallyImportedIds: modules[id].dynamicallyImportedIds ?? [],
          }
        : null,
  };
}

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

describe('collectGraphSpecifiers', () => {
  it('collects both static and dynamic import ids across all modules', () => {
    const graph = fakeGraph({
      '/abs/entry.mjs': { importedIds: ['tldts', '/abs/internal.mjs'], dynamicallyImportedIds: ['jimp'] },
      '/abs/internal.mjs': { importedIds: ['axios'] },
    });
    expect([...collectGraphSpecifiers(graph)].sort()).toEqual(['/abs/internal.mjs', 'axios', 'jimp', 'tldts']);
  });

  it('skips modules whose info is null', () => {
    const graph: ModuleGraph = {
      getModuleIds: () => ['/abs/a.mjs', '/abs/missing.mjs'],
      getModuleInfo: id => (id === '/abs/a.mjs' ? { importedIds: ['tldts'], dynamicallyImportedIds: [] } : null),
    };
    expect([...collectGraphSpecifiers(graph)]).toEqual(['tldts']);
  });

  it('feeds findUndeclaredBundleDeps end-to-end (the plugin path)', () => {
    const graph = fakeGraph({
      '/abs/entry.mjs': {
        importedIds: ['tldts', 'node:fs', '@bike4mind/utils', '/abs/x.mjs'],
        dynamicallyImportedIds: ['jimp'],
      },
    });
    const missing = findUndeclaredBundleDeps(collectGraphSpecifiers(graph), new Set(['tldts']));
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
