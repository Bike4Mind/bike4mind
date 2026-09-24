import { describe, it, expect } from 'vitest';
import { scopeTagCountsToLakes, seedEmptyLakeTags, type TagCount } from './scopeTagCountsToLakes';

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

describe('seedEmptyLakeTags', () => {
  it('adds a zero-count entry for a lake with no tagged files', () => {
    expect(seedEmptyLakeTags(counts, [{ fileTagPrefix: 'empty-lake:' }])).toEqual([
      ...counts,
      { tag: 'empty-lake', count: 0 },
    ]);
  });

  it('strips the trailing colon so the seed tag matches buildTagTree splitting', () => {
    expect(seedEmptyLakeTags([], [{ fileTagPrefix: 'acme:' }])).toEqual([{ tag: 'acme', count: 0 }]);
  });

  it('leaves a lake with existing tagged content untouched, not seeded twice', () => {
    expect(seedEmptyLakeTags(counts, [{ fileTagPrefix: 'research:' }])).toBe(counts);
  });

  it('does not match a prefix that merely shares a leading substring', () => {
    // 'research:' must not read 'researchers:notes' as content, or a genuinely empty
    // "research" lake would silently skip its seed.
    const withNeighbour: TagCount[] = [{ tag: 'researchers:notes', count: 9 }];
    expect(seedEmptyLakeTags(withNeighbour, [{ fileTagPrefix: 'research:' }])).toEqual([
      ...withNeighbour,
      { tag: 'research', count: 0 },
    ]);
  });

  it('seeds a nested prefix as its own multi-segment tag, not the bare first segment', () => {
    // A bare "acme" seed would misfile under a sibling lake sharing that first segment
    // (e.g. a plain "acme:" lake) rather than staying its own nested branch.
    expect(seedEmptyLakeTags([], [{ fileTagPrefix: 'acme:legal:' }])).toEqual([{ tag: 'acme:legal', count: 0 }]);
  });

  it('seeds every empty lake in a multi-lake list, once each', () => {
    expect(
      seedEmptyLakeTags(counts, [{ fileTagPrefix: 'empty-a:' }, { fileTagPrefix: 'empty-b:' }]).slice(counts.length)
    ).toEqual([
      { tag: 'empty-a', count: 0 },
      { tag: 'empty-b', count: 0 },
    ]);
  });

  it('returns the input untouched (identity) when every lake already has content', () => {
    expect(seedEmptyLakeTags(counts, [{ fileTagPrefix: 'research:' }, { fileTagPrefix: 'legal:' }])).toBe(counts);
  });

  it('skips a lake with no usable prefix rather than throwing - malformed/legacy data only', () => {
    expect(seedEmptyLakeTags(counts, [{ fileTagPrefix: '' }])).toBe(counts);
  });

  it('handles an empty lakes list without throwing', () => {
    expect(seedEmptyLakeTags(counts, [])).toBe(counts);
  });
});
