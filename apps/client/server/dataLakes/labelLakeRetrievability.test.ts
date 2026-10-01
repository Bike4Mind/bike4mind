import { describe, it, expect } from 'vitest';
import { labelLakeRetrievability } from './labelLakeRetrievability';
import type { RetrievalLakeScope } from './resolveRetrievalLakeScope';

const scopeOf = (tags: string[], lakeViewComplete?: boolean) =>
  ({
    lakeViewComplete,
    excludedByAccessCount: 0,
    dataLakeTags: tags,
    dataLakeTagPrefixes: [],
    scopedTagPrefixes: [],
    lakes: tags.map(datalakeTag => ({ datalakeTag })),
  }) as unknown as RetrievalLakeScope;

const row = (id: string) => ({ id, datalakeTag: `datalake:${id}` });

describe('labelLakeRetrievability', () => {
  it('returns an empty list for no rows', () => {
    expect(labelLakeRetrievability([], scopeOf(['datalake:a']))).toEqual([]);
  });

  it('labels every row false against an empty scope', () => {
    expect(labelLakeRetrievability([row('a'), row('b')], scopeOf([])).map(r => r.retrievable)).toEqual([false, false]);
  });

  it('leaves rows unlabeled when the scope view is incomplete', () => {
    const rows = [row('a')];
    expect(labelLakeRetrievability(rows, scopeOf(['datalake:a'], false))).toEqual(rows);
  });

  it('labels registry and dynamic lakes by meta-tag and never drops a row', () => {
    const rows = [row('registry'), row('dynamic'), row('absent')];
    const labeled = labelLakeRetrievability(rows, scopeOf(['datalake:registry', 'datalake:dynamic']));
    expect(labeled.map(r => [r.id, r.retrievable])).toEqual([
      ['registry', true],
      ['dynamic', true],
      ['absent', false],
    ]);
  });

  it('marks a lake reached only through a session attachment false (the label is session-agnostic)', () => {
    // Chat unions attachment and preauthorized lakes per session; the caller scope does not include them.
    const labeled = labelLakeRetrievability([row('attached-only')], scopeOf(['datalake:other']));
    expect(labeled[0].retrievable).toBe(false);
  });
});
