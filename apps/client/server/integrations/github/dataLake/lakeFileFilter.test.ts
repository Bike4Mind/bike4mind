import { describe, it, expect } from 'vitest';
import { GITHUB_LAKE_FILE_RULES, checkLakeFileContent, classifyTreeEntry, lakeFileMimeType } from './lakeFileFilter';

const MB = 1024 * 1024;
const blob = (path: string, size = 10, mode = '100644') => ({ path, mode, type: 'blob', sha: `sha-${path}`, size });

describe('classifyTreeEntry', () => {
  it.each([
    'README.md',
    'docs/guide.mdx',
    'notes.txt',
    'docs/api.rst',
    'docs/book.adoc',
    'src/index.ts',
    'src/App.tsx',
    'lib/main.rs',
    'cmd/main.go',
    'app/models.py',
    'scripts/run.sh',
    'db/schema.sql',
    'config/app.yaml',
    'config/app.yml',
    'Cargo.toml',
    'setup.ini',
    'package.json',
    'README',
    'LICENSE',
    'Dockerfile',
    'Makefile',
    'services/api/Makefile',
    'readme',
    'Readme',
    'license',
    'makefile',
  ])('accepts %s', path => {
    expect(classifyTreeEntry(blob(path), MB)).toEqual({ ok: true, candidate: { path, sha: `sha-${path}`, size: 10 } });
  });

  it.each([
    ['image.png', 'extension'],
    ['archive.zip', 'extension'],
    ['.gitignore', 'extension'],
    ['.env', 'extension'],
    ['notes', 'extension'],
    ['node_modules/pkg/index.js', 'denied_path'],
    ['packages/a/dist/out.js', 'denied_path'],
    ['vendor/lib.go', 'denied_path'],
    ['app/build/main.ts', 'denied_path'],
    ['.git/config.ini', 'denied_path'],
    ['third_party/zlib.c', 'denied_path'],
    ['.next/server.js', 'denied_path'],
    ['target/debug/main.rs', 'denied_path'],
    ['app/__pycache__/m.py', 'denied_path'],
    ['pnpm-lock.yaml', 'lockfile'],
    ['web/package-lock.json', 'lockfile'],
    ['yarn.lock', 'lockfile'],
    ['Cargo.lock', 'lockfile'],
    ['poetry.lock', 'lockfile'],
    ['Gemfile.lock', 'lockfile'],
    ['go.sum', 'lockfile'],
    ['composer.lock', 'lockfile'],
    ['gemfile.lock', 'lockfile'],
    ['Yarn.lock', 'lockfile'],
  ] as const)('rejects %s as %s', (path, reason) => {
    expect(classifyTreeEntry(blob(path), MB)).toEqual({ ok: false, reason });
  });

  it('matches a denied directory by whole segment, not by substring', () => {
    expect(classifyTreeEntry(blob('buildscripts/run.sh'), MB).ok).toBe(true);
    expect(classifyTreeEntry(blob('src/distance.ts'), MB).ok).toBe(true);
  });

  it('skips submodules and subtrees', () => {
    expect(classifyTreeEntry({ path: 'deps/lib', mode: '160000', type: 'commit', sha: 'c1' }, MB)).toEqual({
      ok: false,
      reason: 'not_blob',
    });
    expect(classifyTreeEntry({ path: 'src', mode: '040000', type: 'tree', sha: 't1' }, MB)).toEqual({
      ok: false,
      reason: 'not_blob',
    });
  });

  it('skips symlinks even when the name is allowlisted', () => {
    expect(classifyTreeEntry(blob('docs/link.md', 10, '120000'), MB)).toEqual({ ok: false, reason: 'symlink' });
  });

  it('caps the size from the tree entry, inclusive at the limit', () => {
    expect(classifyTreeEntry(blob('big.md', MB), MB).ok).toBe(true);
    expect(classifyTreeEntry(blob('big.md', MB + 1), MB)).toEqual({ ok: false, reason: 'oversized' });
    expect(classifyTreeEntry(blob('small.md', 600), 512)).toEqual({ ok: false, reason: 'oversized' });
  });

  it('states the spec caps in the one exported constant', () => {
    expect(GITHUB_LAKE_FILE_RULES.maxFileBytes).toBe(MB);
    expect(GITHUB_LAKE_FILE_RULES.maxCandidates).toBe(5000);
  });
});

describe('checkLakeFileContent', () => {
  it('accepts UTF-8 text, multi-byte included', () => {
    expect(checkLakeFileContent(Buffer.from('h\u00e9llo \u2603\n'))).toBe('ok');
  });

  it('flags a NUL byte in the first 8 KB as binary', () => {
    expect(checkLakeFileContent(Buffer.from([0x68, 0x00, 0x69]))).toBe('binary');
  });

  it('only sniffs the first 8 KB for NUL', () => {
    expect(checkLakeFileContent(Buffer.concat([Buffer.alloc(8192, 0x61), Buffer.from([0x00])]))).toBe('ok');
  });

  it('flags bytes that fail strict UTF-8 decode', () => {
    expect(checkLakeFileContent(Buffer.from([0x68, 0xc3, 0x28]))).toBe('invalid_utf8');
  });
});

describe('lakeFileMimeType', () => {
  it.each([
    ['README.md', 'text/markdown'],
    ['docs/a.mdx', 'text/markdown'],
    ['package.json', 'application/json'],
    ['src/index.ts', 'text/plain'],
    ['lib/main.rs', 'text/plain'],
    ['scripts/run.sh', 'text/plain'],
    ['config/app.yaml', 'text/plain'],
    ['Dockerfile', 'text/plain'],
  ])('%s is stored as %s', (path, mimeType) => {
    expect(lakeFileMimeType(path)).toBe(mimeType);
  });
});
