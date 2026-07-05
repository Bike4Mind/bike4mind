import { describe, it, expect } from 'vitest';
import { buildTagTree, getNodesAtPath, TagNode } from '../parseTagNamespace';

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

    const b = a.children[0];
    expect(b.segment).toBe('b');
    expect(b.fileCount).toBe(9); // 2 (own) + 7 (from child c)
    expect(b.children).toHaveLength(1);
    expect(b.children[0]).toMatchObject({ segment: 'c', fileCount: 7 });
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
