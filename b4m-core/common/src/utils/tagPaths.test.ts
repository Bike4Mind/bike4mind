import { describe, it, expect } from 'vitest';
import { countTagPaths, countTagPathsByTagSet } from './tagPaths';

describe('countTagPaths', () => {
  const byTag = (rows: ReturnType<typeof countTagPaths>) => Object.fromEntries(rows.map(r => [r.tag, r]));

  it('emits every ancestor path with distinct file counts', () => {
    const rows = byTag(countTagPaths([['acme:legal:a', 'acme:legal:b'], ['acme:legal:a'], ['acme:hr']]));

    expect(rows['acme']).toEqual({ tag: 'acme', count: 0, fileCount: 3 });
    expect(rows['acme:legal']).toEqual({ tag: 'acme:legal', count: 0, fileCount: 2 });
    expect(rows['acme:legal:a']).toEqual({ tag: 'acme:legal:a', count: 2, fileCount: 2 });
    expect(rows['acme:legal:b']).toEqual({ tag: 'acme:legal:b', count: 1, fileCount: 1 });
    expect(rows['acme:hr']).toEqual({ tag: 'acme:hr', count: 1, fileCount: 1 });
  });

  it('counts a tag repeated on one file once', () => {
    expect(countTagPaths([['acme:a', 'acme:a']])).toEqual([
      { tag: 'acme', count: 0, fileCount: 1 },
      { tag: 'acme:a', count: 1, fileCount: 1 },
    ]);
  });

  it('counts a file tagged with a branch and a tag under it once at the branch', () => {
    const rows = byTag(countTagPaths([['acme:legal', 'acme:legal:a']]));

    expect(rows['acme:legal']).toEqual({ tag: 'acme:legal', count: 1, fileCount: 1 });
  });

  // Same rows the server counter's suite pins for these tags.
  it('expands tags with empty segments the way the server counter does', () => {
    const rows = countTagPaths([['acme::x', 'acme:legal:']]).sort((a, b) => a.tag.localeCompare(b.tag));

    expect(rows).toEqual([
      { tag: 'acme', count: 0, fileCount: 1 },
      { tag: 'acme:', count: 0, fileCount: 1 },
      { tag: 'acme::x', count: 1, fileCount: 1 },
      { tag: 'acme:legal', count: 0, fileCount: 1 },
      { tag: 'acme:legal:', count: 1, fileCount: 1 },
    ]);
  });

  it('returns nothing for files with no tags', () => {
    expect(countTagPaths([[], []])).toEqual([]);
  });
});

describe('countTagPathsByTagSet', () => {
  it('weights each tag set by how many files share it', () => {
    const rows = countTagPathsByTagSet([
      { tags: ['acme:legal:a', 'acme:legal:b'], files: 3 },
      { tags: ['acme:hr'], files: 2 },
    ]);
    const byTag = Object.fromEntries(rows.map(r => [r.tag, r]));

    expect(byTag['acme']).toEqual({ tag: 'acme', count: 0, fileCount: 5 });
    expect(byTag['acme:legal']).toEqual({ tag: 'acme:legal', count: 0, fileCount: 3 });
    expect(byTag['acme:legal:a']).toEqual({ tag: 'acme:legal:a', count: 3, fileCount: 3 });
  });

  it('adds up one tag set split across two groups', () => {
    const split = countTagPathsByTagSet([
      { tags: ['acme:a', 'acme:b'], files: 1 },
      { tags: ['acme:b', 'acme:a'], files: 2 },
    ]);

    expect(split).toEqual(countTagPathsByTagSet([{ tags: ['acme:a', 'acme:b'], files: 3 }]));
  });
});
