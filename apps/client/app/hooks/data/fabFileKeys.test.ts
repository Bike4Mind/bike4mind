import { describe, it, expect } from 'vitest';
import { fabFileKeys } from './fabFileKeys';

// Each assertion pins a registry entry to the exact literal it replaced in
// fabFiles.ts (and the 16 files converged in the final task). If one of these
// changes shape, cached data silently detaches from its invalidations.
describe('fabFileKeys parity with pre-registry literals', () => {
  it('doc-level keys', () => {
    expect(fabFileKeys.all).toEqual(['fabFiles']);
    expect(fabFileKeys.doc('f1')).toEqual(['fabFiles', 'f1']);
    expect(fabFileKeys.doc(null)).toEqual(['fabFiles', null]);
    expect(fabFileKeys.content('f1')).toEqual(['fabFiles', 'f1', 'content']);
    expect(fabFileKeys.content(undefined)).toEqual(['fabFiles', undefined, 'content']);
    expect(fabFileKeys.name('f1')).toEqual(['fabFiles', 'name', 'f1']);
  });

  it('own-list and quest keys', () => {
    expect(fabFileKeys.own).toEqual(['fabFiles', 'own']);
    const params = { search: 'x', filters: {}, sort: 'asc', sortField: 'createdAt' };
    expect(fabFileKeys.ownList(params)).toEqual(['fabFiles', 'own', params]);
    expect(fabFileKeys.ownBySession('s1')).toEqual(['fabFiles', 'own', { sessionId: 's1' }]);
    expect(fabFileKeys.quest('q1')).toEqual(['fabFiles', 'quest', 'q1']);
  });

  it('search keys keep params in the key, including undefined', () => {
    expect(fabFileKeys.search(undefined)).toEqual(['fabFiles', 'search', undefined]);
    const p = { search: 'x' };
    expect(fabFileKeys.search(p)).toEqual(['fabFiles', 'search', p]);
    expect(fabFileKeys.searchInfinite(p)).toEqual(['fabFiles', 'search', 'infinite', p]);
    expect(fabFileKeys.searchPaginated({ ...p, page: 2 })).toEqual([
      'fabFiles',
      'search',
      'paginated',
      { search: 'x', page: 2 },
    ]);
    const c = { searchTerm: 'x', filters: {}, sort: 'asc', sortField: 'createdAt', page: 1 };
    expect(fabFileKeys.combined(c)).toEqual(['fabFiles', 'combined', c]);
  });
});
