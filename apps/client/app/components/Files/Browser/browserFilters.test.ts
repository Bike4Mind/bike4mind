import { describe, expect, it } from 'vitest';
import {
  hasUserFilters,
  isFilterLocked,
  lockedFilterLabels,
  toSearchFilters,
  withLockedFilters,
} from './browserFilters';

describe('toSearchFilters', () => {
  it('maps each typed filter onto its wire key', () => {
    expect(toSearchFilters({ source: 'generated', type: 'video', model: 'veo-3', starred: true })).toEqual({
      generated: true,
      type: 'video',
      model: 'veo-3',
      starred: true,
    });
    expect(toSearchFilters({ source: 'uploaded' })).toEqual({ uploaded: true });
  });

  it('omits unset keys instead of sending false', () => {
    expect(toSearchFilters(undefined)).toEqual({});
    expect(toSearchFilters({ starred: false })).toEqual({});
  });
});

describe('withLockedFilters', () => {
  it('lays the locked filters over the user ones', () => {
    expect(withLockedFilters({ search: 'cat', filters: { type: 'image' } }, { type: 'video' })).toEqual({
      search: 'cat',
      filters: { type: 'video' },
    });
  });

  it('a locked source drops the opposite user source', () => {
    expect(withLockedFilters({ filters: { uploaded: true } }, { source: 'generated' }).filters).toEqual({
      generated: true,
      uploaded: undefined,
    });
  });

  it('returns the params untouched with nothing locked', () => {
    const params = { filters: { starred: true } };
    expect(withLockedFilters(params, undefined)).toBe(params);
  });
});

describe('hasUserFilters', () => {
  it.each([
    { search: 'x' },
    { filters: { model: 'm' } },
    { filters: { starred: true } },
    { filters: { uploaded: true } },
  ])('is true for %j', params => expect(hasUserFilters(params)).toBe(true));

  it('is false for no filters', () => expect(hasUserFilters({ filters: {} })).toBe(false));
});

describe('locked filter helpers', () => {
  it('reports a key as locked only when it narrows', () => {
    expect(isFilterLocked({ source: 'generated' }, 'source')).toBe(true);
    expect(isFilterLocked({ starred: false }, 'starred')).toBe(false);
    expect(isFilterLocked(undefined, 'type')).toBe(false);
  });

  it('labels the locked filters in a stable order', () => {
    expect(lockedFilterLabels({ starred: true, model: 'veo-3', type: 'video', source: 'generated' })).toEqual([
      { key: 'source', label: 'Generated' },
      { key: 'type', label: 'Video' },
      { key: 'model', label: 'veo-3' },
      { key: 'starred', label: 'Starred' },
    ]);
  });
});
