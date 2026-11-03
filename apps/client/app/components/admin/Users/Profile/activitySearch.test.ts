import { describe, expect, it } from 'vitest';
import { activityFiltersFromSearch, activitySearchFromFilters, parseActivitySearch } from './activitySearch';
import { parseUserProfileSearch } from './userProfileSearch';

describe('parseActivitySearch', () => {
  it('keeps known types in canonical order without duplicates', () => {
    expect(parseActivitySearch({ types: 'admin,signin,admin,bogus' })).toEqual({ types: 'signin,admin' });
  });

  it('drops a type list that names nothing or everything', () => {
    expect(parseActivitySearch({ types: 'bogus' }).types).toBeUndefined();
    expect(parseActivitySearch({ types: 'signin,usage,credit,key,admin' }).types).toBeUndefined();
  });

  it('keeps valid days, drops invalid ones and swaps a reversed range', () => {
    expect(parseActivitySearch({ from: '2026-10-20', to: '2026-10-01' })).toMatchObject({
      from: '2026-10-01',
      to: '2026-10-20',
    });
    expect(parseActivitySearch({ from: '2026-02-30', to: 'yesterday' })).toMatchObject({
      from: undefined,
      to: undefined,
    });
  });
});

describe('activity filters round trip', () => {
  it('reads absent types as every source', () => {
    expect(activityFiltersFromSearch({}).types).toEqual(['signin', 'usage', 'credit', 'key', 'admin']);
  });

  it('writes the filters back as short URL params', () => {
    expect(activitySearchFromFilters({ types: ['credit', 'usage'], from: '2026-10-01' })).toEqual({
      types: 'usage,credit',
      from: '2026-10-01',
      to: undefined,
    });
  });
});

describe('parseUserProfileSearch with activity filters', () => {
  const routeSearch = (raw: Record<string, unknown>) => ({ ...raw, ...parseUserProfileSearch(raw) });

  it('keeps the filters on the activity tab', () => {
    expect(routeSearch({ tab: 'activity', types: 'admin', from: '2026-10-01' })).toMatchObject({
      tab: 'activity',
      types: 'admin',
      from: '2026-10-01',
    });
  });

  it('clears them on any other tab so they cannot leak into its URL', () => {
    const search = routeSearch({ tab: 'credits', types: 'admin', from: '2026-10-01', to: '2026-10-02' });
    expect(search).toMatchObject({ tab: 'credits', types: undefined, from: undefined, to: undefined });
  });
});
