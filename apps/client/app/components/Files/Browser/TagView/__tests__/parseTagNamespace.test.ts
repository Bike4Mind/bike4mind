import { describe, it, expect } from 'vitest';
import { buildTagTree, countTagPaths, getNodeAtPath, getNodesAtPath, TagNode } from '../parseTagNamespace';

describe('buildTagTree', () => {
  it('returns empty array for empty input', () => {
    expect(buildTagTree([])).toEqual([]);
  });

  it('handles single-segment tags (no colons)', () => {
    const result = buildTagTree([
      { tag: 'alpha', count: 3 },
      { tag: 'beta', count: 5 },
    ]);

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ segment: 'alpha', fullPath: 'alpha', fileCount: 3, children: [] });
    expect(result[1]).toMatchObject({ segment: 'beta', fullPath: 'beta', fileCount: 5, children: [] });
  });

  it('builds a two-level tree from colon-separated tags', () => {
    const result = buildTagTree([
      { tag: 'opti:scheduling', count: 10 },
      { tag: 'opti:budgeting', count: 5 },
    ]);

    expect(result).toHaveLength(1);
    const opti = result[0];
    expect(opti.segment).toBe('opti');
    expect(opti.fullPath).toBe('opti');
    expect(opti.fileCount).toBe(15); // 10 + 5 propagated up
    expect(opti.children).toHaveLength(2);

    // Children sorted alphabetically
    expect(opti.children[0]).toMatchObject({ segment: 'budgeting', fullPath: 'opti:budgeting', fileCount: 5 });
    expect(opti.children[1]).toMatchObject({ segment: 'scheduling', fullPath: 'opti:scheduling', fileCount: 10 });
  });

  it('builds a three-level tree and propagates counts correctly', () => {
    const result = buildTagTree([
      { tag: 'opti:family:scheduling', count: 12 },
      { tag: 'opti:family:budgeting', count: 8 },
      { tag: 'opti:work', count: 3 },
    ]);

    expect(result).toHaveLength(1);
    const opti = result[0];
    expect(opti.fileCount).toBe(23); // 12 + 8 + 3

    const family = opti.children.find(n => n.segment === 'family');
    expect(family).toBeDefined();
    expect(family!.fileCount).toBe(20); // 12 + 8
    expect(family!.children).toHaveLength(2);

    const work = opti.children.find(n => n.segment === 'work');
    expect(work).toBeDefined();
    expect(work!.fileCount).toBe(3);
  });

  it('handles overlapping prefixes correctly (a:b and a:b:c)', () => {
    const result = buildTagTree([
      { tag: 'a:b', count: 2 },
      { tag: 'a:b:c', count: 7 },
    ]);

    const a = result[0];
    expect(a.fileCount).toBe(9); // 2 + 7
    expect(a.ownFileCount).toBe(0); // "a" itself is never a tag on its own here

    const b = a.children[0];
    expect(b.segment).toBe('b');
    expect(b.fileCount).toBe(9); // 2 (own) + 7 (from child c)
    expect(b.ownFileCount).toBe(2); // what fileCount alone can't surface once b has children
    expect(b.children).toHaveLength(1);
    expect(b.children[0]).toMatchObject({ segment: 'c', fileCount: 7, ownFileCount: 7 });
  });

  it('sorts children alphabetically at each level', () => {
    const result = buildTagTree([
      { tag: 'z:beta', count: 1 },
      { tag: 'a:gamma', count: 1 },
      { tag: 'z:alpha', count: 1 },
    ]);

    // Root level sorted: a, z
    expect(result[0].segment).toBe('a');
    expect(result[1].segment).toBe('z');

    // z's children sorted: alpha, beta
    expect(result[1].children[0].segment).toBe('alpha');
    expect(result[1].children[1].segment).toBe('beta');
  });

  it('aggregates counts for duplicate tags', () => {
    const result = buildTagTree([
      { tag: 'project:docs', count: 3 },
      { tag: 'project:docs', count: 7 },
    ]);

    const docs = result[0].children[0];
    expect(docs.fileCount).toBe(10);
    expect(result[0].fileCount).toBe(10);
  });

  it('handles multiple root namespaces', () => {
    const result = buildTagTree([
      { tag: 'work:tasks', count: 5 },
      { tag: 'personal:photos', count: 3 },
      { tag: 'work:notes', count: 2 },
    ]);

    expect(result).toHaveLength(2);
    expect(result[0].segment).toBe('personal'); // alphabetical
    expect(result[1].segment).toBe('work');
    expect(result[1].fileCount).toBe(7); // 5 + 2
  });
});

describe('getNodesAtPath', () => {
  const tree: TagNode[] = buildTagTree([
    { tag: 'opti:family:scheduling', count: 12 },
    { tag: 'opti:family:budgeting', count: 8 },
    { tag: 'opti:work', count: 3 },
    { tag: 'misc', count: 1 },
  ]);

  it('returns root nodes for empty breadcrumb', () => {
    const result = getNodesAtPath(tree, []);
    expect(result).toBe(tree);
  });

  it('returns children at depth 1', () => {
    const result = getNodesAtPath(tree, ['opti']);
    expect(result).toHaveLength(2); // family, work
    expect(result.map(n => n.segment)).toEqual(['family', 'work']);
  });

  it('returns children at depth 2', () => {
    const result = getNodesAtPath(tree, ['opti', 'family']);
    expect(result).toHaveLength(2); // budgeting, scheduling
    expect(result.map(n => n.segment)).toEqual(['budgeting', 'scheduling']);
  });

  it('returns empty array for non-existent path', () => {
    expect(getNodesAtPath(tree, ['nonexistent'])).toEqual([]);
  });

  it('returns empty array for partial non-existent path', () => {
    expect(getNodesAtPath(tree, ['opti', 'nonexistent'])).toEqual([]);
  });

  it('returns empty array for leaf node breadcrumb (no children)', () => {
    const result = getNodesAtPath(tree, ['opti', 'work']);
    expect(result).toEqual([]); // work is a leaf, has no children
  });
});

describe('getNodeAtPath', () => {
  const tree: TagNode[] = buildTagTree([
    { tag: 'a:b', count: 2 },
    { tag: 'a:b:c', count: 7 },
  ]);

  it('returns null for the root (empty breadcrumb)', () => {
    expect(getNodeAtPath(tree, [])).toBeNull();
  });

  it('returns null for a non-existent path', () => {
    expect(getNodeAtPath(tree, ['nonexistent'])).toBeNull();
  });

  it('returns the node itself, not its children, so ownFileCount is reachable at a branch', () => {
    const b = getNodeAtPath(tree, ['a', 'b']);
    expect(b).not.toBeNull();
    expect(b!.segment).toBe('b');
    expect(b!.fileCount).toBe(9);
    expect(b!.ownFileCount).toBe(2);
    expect(b!.children).toHaveLength(1);
  });
});

describe('buildTagTree with distinct per-path counts', () => {
  // 3 files, each tagged acme:legal:{a,b,c,d}: summing the leaves gave the branch 12.
  const multiTagged = [
    { tag: 'acme', count: 0, fileCount: 3 },
    { tag: 'acme:legal', count: 0, fileCount: 3 },
    ...['a', 'b', 'c', 'd'].map(leaf => ({ tag: `acme:legal:${leaf}`, count: 3, fileCount: 3 })),
  ];

  it('takes a branch count from its row instead of summing the leaves', () => {
    const tree = buildTagTree(multiTagged);

    expect(getNodeAtPath(tree, ['acme'])?.fileCount).toBe(3);
    expect(getNodeAtPath(tree, ['acme', 'legal'])?.fileCount).toBe(3);
    expect(getNodeAtPath(tree, ['acme', 'legal', 'a'])?.fileCount).toBe(3);
  });

  it('gives an ancestor-only row no files of its own', () => {
    const legal = getNodeAtPath(buildTagTree(multiTagged), ['acme', 'legal']);

    expect(legal?.ownFileCount).toBe(0);
    expect(legal?.children).toHaveLength(4);
  });

  it('falls back to the sum for a path no row counted distinctly', () => {
    // A single-lake scope drops the rows above the lake root, as here for `acme`.
    const tree = buildTagTree(multiTagged.filter(row => row.tag.startsWith('acme:')));

    expect(getNodeAtPath(tree, ['acme'])?.fileCount).toBe(3);
    expect(getNodeAtPath(tree, ['acme', 'legal'])?.fileCount).toBe(3);
  });

  it('builds the same tree from the rows countTagPaths emits', () => {
    const leaves = ['acme:legal:a', 'acme:legal:b', 'acme:legal:c', 'acme:legal:d'];
    const tree = buildTagTree(countTagPaths([leaves, leaves, leaves]));

    expect(getNodeAtPath(tree, ['acme', 'legal'])?.fileCount).toBe(3);
  });
});

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

  it('returns nothing for files with no tags', () => {
    expect(countTagPaths([[], []])).toEqual([]);
  });
});
