import { describe, expect, it } from 'vitest';
import { computeMcpContentHash } from '../mcpContentHash.js';

/**
 * Pins the contract of the MCP_VERSION input in infra/mcp.ts. Nothing imports that file, so the
 * computation lives here to be testable at all - the hash is the only thing that makes a
 * code-only change redeploy the MCP lambda, and every way it can go quietly constant is the
 * lambda serving previous code with no error anywhere.
 */
const PATHS = ['b4m-core/mcp', 'b4m-core/common', 'b4m-core/hearth'];

const treeLine = (path: string, sha: string, file = 'src/index.ts') => `100644 blob ${sha}\t${path}/${file}\n`;

const TREES: Record<string, string> = {
  'b4m-core/mcp': treeLine('b4m-core/mcp', 'aaa111'),
  'b4m-core/common': treeLine('b4m-core/common', 'bbb222'),
  'b4m-core/hearth': treeLine('b4m-core/hearth', 'ccc333'),
};

const sources = (trees: Record<string, string> = TREES, paths: readonly string[] = PATHS) => ({
  paths,
  readTree: (path: string) => trees[path] ?? '',
});

describe('computeMcpContentHash', () => {
  it('is deterministic for identical inputs', () => {
    expect(computeMcpContentHash(sources())).toBe(computeMcpContentHash(sources()));
  });

  it('is short enough to read in an env var and stable in length', () => {
    expect(computeMcpContentHash(sources())).toMatch(/^[0-9a-f]{8}$/);
  });

  it.each(PATHS)('changes when code under %s changes', changed => {
    const edited = { ...TREES, [changed]: treeLine(changed, 'deadbeef') };
    expect(computeMcpContentHash(sources(edited))).not.toBe(computeMcpContentHash(sources()));
  });

  it('changes when a file is renamed with identical content', () => {
    // The pipeline this replaced kept only the blob SHA column, so a rename moved no bits and
    // the bundle shipped a differently-named module under an unchanged MCP_VERSION.
    const renamed = { ...TREES, 'b4m-core/mcp': treeLine('b4m-core/mcp', 'aaa111', 'src/entry.ts') };
    expect(computeMcpContentHash(sources(renamed))).not.toBe(computeMcpContentHash(sources()));
  });

  it.each(PATHS)('throws rather than hashing a smaller set when %s is absent from the tree', missing => {
    // `git ls-tree -r HEAD <path>` exits 0 with no output when the path is not in the tree, so a
    // single multi-path read drops that path's files silently and keeps hashing the rest.
    const partial = { ...TREES, [missing]: '' };
    expect(() => computeMcpContentHash(sources(partial))).toThrow(`listed no files under ${missing}`);
  });

  it('throws when every path is absent, which would otherwise hash to md5 of nothing', () => {
    expect(() => computeMcpContentHash(sources({}))).toThrow(/listed no files/);
    expect(() => computeMcpContentHash(sources({ 'b4m-core/mcp': '  \n' }))).toThrow(/listed no files/);
  });

  it('throws when the path list is empty', () => {
    expect(() => computeMcpContentHash(sources(TREES, []))).toThrow(/no paths given/);
  });

  it('propagates a git failure rather than swallowing it', () => {
    const failing = {
      paths: PATHS,
      readTree: () => {
        throw new Error('fatal: not a git repository');
      },
    };
    expect(() => computeMcpContentHash(failing)).toThrow(/not a git repository/);
  });

  it('distinguishes identical trees read for different paths', () => {
    const same = treeLine('shared', 'aaa111');
    const a = computeMcpContentHash({ paths: ['b4m-core/mcp'], readTree: () => same });
    const b = computeMcpContentHash({ paths: ['b4m-core/hearth'], readTree: () => same });
    expect(a).not.toBe(b);
  });
});
