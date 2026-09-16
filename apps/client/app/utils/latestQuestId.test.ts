import { describe, it, expect } from 'vitest';
import { latestQuestId } from './latestQuestId';

describe('latestQuestId', () => {
  it('returns undefined for an empty or missing cache', () => {
    expect(latestQuestId(undefined)).toBeUndefined();
    expect(latestQuestId({ pages: [] })).toBeUndefined();
    expect(latestQuestId({ pages: [{ data: [] }] })).toBeUndefined();
  });

  it('picks the newest id across pages regardless of page order', () => {
    expect(
      latestQuestId({
        pages: [{ data: [{ id: '651000000000000000000000' }] }, { data: [{ id: '652000000000000000000000' }] }],
      })
    ).toBe('652000000000000000000000');
  });

  it('skips optimistic ids the server cannot resolve', () => {
    expect(
      latestQuestId({
        pages: [{ data: [{ id: 'optimistic-quest-zzz' }, { id: '651000000000000000000000' }] }],
      })
    ).toBe('651000000000000000000000');
  });

  it('skips entries with no id', () => {
    expect(latestQuestId({ pages: [{ data: [{}, { id: '651000000000000000000000' }] }] })).toBe(
      '651000000000000000000000'
    );
  });
});
