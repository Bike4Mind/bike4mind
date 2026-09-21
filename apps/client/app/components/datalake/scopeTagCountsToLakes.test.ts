import { describe, it, expect } from 'vitest';
import { scopeTagCountsToLakes, type TagCount } from './scopeTagCountsToLakes';

const counts: TagCount[] = [
  { tag: 'research:reports:market', count: 3 },
  { tag: 'research:interviews:ops', count: 2 },
  { tag: 'legal:contracts', count: 5 },
  { tag: 'opti:solvers', count: 1 },
];

describe('scopeTagCountsToLakes', () => {
  it('keeps only the selected lake tags, so the tree shows that lake alone', () => {
    expect(scopeTagCountsToLakes(counts, [{ fileTagPrefix: 'research:' }]).map(c => c.tag)).toEqual([
      'research:reports:market',
      'research:interviews:ops',
    ]);
  });

  it('returns every tag untouched in the all-lakes scope (an empty selection)', () => {
    // Identity, not merely equal-length: the unscoped page must behave exactly as before.
    expect(scopeTagCountsToLakes(counts, [])).toBe(counts);
  });

  it('preserves counts, not just tag names', () => {
    expect(scopeTagCountsToLakes(counts, [{ fileTagPrefix: 'legal:' }])).toEqual([
      { tag: 'legal:contracts', count: 5 },
    ]);
  });

  it('yields nothing for a lake with no tagged content, rather than falling back to everything', () => {
    // The empty-vs-unscoped distinction is load-bearing: returning all tags here would make an
    // empty lake look like it contained every other lake's content.
    expect(scopeTagCountsToLakes(counts, [{ fileTagPrefix: 'empty-lake:' }])).toEqual([]);
  });

  it('does not match a prefix that merely shares a leading substring', () => {
    // 'research' without the colon must not match 'researchers:'; the trailing colon is what makes
    // the prefix a namespace boundary rather than a text match.
    const withNeighbour: TagCount[] = [...counts, { tag: 'researchers:notes', count: 9 }];
    expect(scopeTagCountsToLakes(withNeighbour, [{ fileTagPrefix: 'research:' }]).map(c => c.tag)).not.toContain(
      'researchers:notes'
    );
  });

  it('documents the overlapping-prefix case: a parent prefix absorbs a child lake tags', () => {
    // Not desired behaviour - it is the consequence of prefix containment, and the reason
    // overlapping prefixes are refused at create time (tagPrefixIssue). Pinned so that if the
    // create-time guard is ever relaxed, this shows up as a decision rather than a surprise.
    const nested: TagCount[] = [
      { tag: 'research:reports:market', count: 3 },
      { tag: 'research:deep:genomics', count: 7 },
    ];
    expect(scopeTagCountsToLakes(nested, [{ fileTagPrefix: 'research:' }])).toHaveLength(2);
    expect(scopeTagCountsToLakes(nested, [{ fileTagPrefix: 'research:deep:' }]).map(c => c.tag)).toEqual([
      'research:deep:genomics',
    ]);
  });

  it('unions the selected lakes, so a two-lake scope shows both trees', () => {
    expect(
      scopeTagCountsToLakes(counts, [{ fileTagPrefix: 'research:' }, { fileTagPrefix: 'opti:' }]).map(c => c.tag)
    ).toEqual(['research:reports:market', 'research:interviews:ops', 'opti:solvers']);
  });

  it('excludes the unselected lakes from a multi-lake scope, which is the whole point of narrowing', () => {
    // The issue this exists for: reach the main corpus WITHOUT the noisier lakes beside it. A
    // union that quietly kept a third lake would defeat the feature while still looking scoped.
    expect(
      scopeTagCountsToLakes(counts, [{ fileTagPrefix: 'research:' }, { fileTagPrefix: 'opti:' }]).map(c => c.tag)
    ).not.toContain('legal:contracts');
  });

  it('yields a tag matching two selected lakes ONCE, not once per lake', () => {
    // A per-lake pass concatenated together would duplicate the branch in the tree and double its
    // count. Only reachable through the legacy overlapping-prefix case, which is exactly why it
    // is pinned rather than assumed away.
    const nested: TagCount[] = [{ tag: 'research:deep:genomics', count: 7 }];
    expect(
      scopeTagCountsToLakes(nested, [{ fileTagPrefix: 'research:' }, { fileTagPrefix: 'research:deep:' }])
    ).toEqual(nested);
  });

  it('handles an empty payload without throwing', () => {
    expect(scopeTagCountsToLakes([], [{ fileTagPrefix: 'research:' }])).toEqual([]);
  });
});
