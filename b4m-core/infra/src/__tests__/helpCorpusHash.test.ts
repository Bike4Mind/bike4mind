import { describe, expect, it } from 'vitest';
import { computeHelpCorpusHash } from '../helpCorpusHash.js';

/**
 * Pins the contract of the HELP_CORPUS_VERSION input in infra/cron.ts. Nothing imports that file,
 * so the computation lives here to be testable at all - the hash is the only thing that makes a
 * docs-only edit redeploy the ingest cron, and every way it can go quietly constant is a stale
 * corpus converging on a 6-hour loop with no error anywhere.
 */
const TREE = '100644 blob abc123\tdocs-site/docs/overview.md\n';
const INDEX = Buffer.from('{"entries":[]}');

const sources = (tree: string, index: Buffer) => ({
  readDocsTree: () => tree,
  readIndex: () => index,
});

describe('computeHelpCorpusHash', () => {
  it('is deterministic for identical inputs', () => {
    expect(computeHelpCorpusHash(sources(TREE, INDEX))).toBe(computeHelpCorpusHash(sources(TREE, INDEX)));
  });

  it('changes when an article body changes', () => {
    const moved = '100644 blob def456\tdocs-site/docs/overview.md\n';
    expect(computeHelpCorpusHash(sources(moved, INDEX))).not.toBe(computeHelpCorpusHash(sources(TREE, INDEX)));
  });

  it('changes when only the index changes, which the docs tree cannot show', () => {
    // The generator's output shape is not derivable from the article bodies, so a build-index
    // change that rewrites every entry moves no tracked docs path.
    const regenerated = Buffer.from('{"entries":[],"schema":2}');
    expect(computeHelpCorpusHash(sources(TREE, regenerated))).not.toBe(computeHelpCorpusHash(sources(TREE, INDEX)));
  });

  it('throws rather than hashing a constant when the docs tree comes back empty', () => {
    // `git ls-tree -r HEAD <path>` exits 0 with no output when the path is absent from the tree,
    // so this is a silent failure and not an error the caller would otherwise see.
    expect(() => computeHelpCorpusHash(sources('', INDEX))).toThrow(/listed no files/);
    expect(() => computeHelpCorpusHash(sources('   \n', INDEX))).toThrow(/listed no files/);
  });

  it('propagates a missing index rather than hashing the docs alone', () => {
    const missing = () => {
      throw new Error('ENOENT: no such file or directory');
    };
    expect(() => computeHelpCorpusHash({ readDocsTree: () => TREE, readIndex: missing })).toThrow(/ENOENT/);
  });

  it('propagates a failed git read rather than seeing it as an empty tree', () => {
    // `git ls-tree` exits non-zero outside a repo, which the caller's exec surfaces as a throw.
    // The empty-tree guard above must not be what handles that: it would name the wrong cause.
    const failed = () => {
      throw new Error('fatal: not a git repository');
    };
    expect(() => computeHelpCorpusHash({ readDocsTree: failed, readIndex: () => INDEX })).toThrow(
      /not a git repository/
    );
  });

  it('is short enough to read in a stage name and stable in length', () => {
    expect(computeHelpCorpusHash(sources(TREE, INDEX))).toMatch(/^[0-9a-f]{8}$/);
  });
});
