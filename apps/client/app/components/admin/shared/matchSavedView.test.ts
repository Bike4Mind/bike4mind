import { describe, expect, it } from 'vitest';
import { matchSavedView, sameViewValues } from './matchSavedView';

describe('sameViewValues', () => {
  it('treats an absent key as undefined and compares every key either side has', () => {
    expect(sameViewValues({}, {})).toBe(true);
    expect(sameViewValues({ status: undefined }, {})).toBe(true);
    expect(sameViewValues({ status: 'active' }, {})).toBe(false);
    expect(sameViewValues({}, { status: 'active' })).toBe(false);
  });

  it('compares arrays item by item and in order', () => {
    expect(sameViewValues({ tags: ['a', 'b'] }, { tags: ['a', 'b'] })).toBe(true);
    expect(sameViewValues({ tags: ['a', 'b'] }, { tags: ['b', 'a'] })).toBe(false);
    expect(sameViewValues({ tags: [] }, { tags: undefined })).toBe(false);
  });

  it('compares only the given keys when asked', () => {
    expect(sameViewValues({ status: 'active', page: 1 }, { status: 'active', page: 4 }, ['status'])).toBe(true);
  });
});

describe('matchSavedView', () => {
  const views = [
    { id: 'all', values: {} },
    { id: 'credits', values: { category: 'credits' } },
    { id: 'credits-again', values: { category: 'credits' } },
  ];

  it('returns the first view whose values match, or undefined', () => {
    expect(matchSavedView(views, { category: 'credits' }, view => view.values)?.id).toBe('credits');
    expect(matchSavedView(views, {}, view => view.values)?.id).toBe('all');
    expect(matchSavedView(views, { category: 'access' }, view => view.values)).toBeUndefined();
  });
});
