import { describe, it, expect } from 'vitest';
import { dataLakeKeys } from './dataLakeKeys';

/**
 * Parity guard: these literals are the exact keys the pre-registry code used (spread across
 * dataLakes.ts, dataLakeWizard.ts, fabFiles.ts and SendToDataLakeModal.tsx). They are asserted
 * as LITERALS on purpose - asserting via the registry would be self-referential and could not
 * catch a rename that silently splits the react-query cache.
 */
describe('dataLakeKeys parity', () => {
  it('lake catalogs', () => {
    expect(dataLakeKeys.list).toEqual(['data-lakes']);
    expect(dataLakeKeys.public('foo')).toEqual(['data-lakes', 'public', { search: 'foo' }]);
    expect(dataLakeKeys.archived).toEqual(['data-lakes', 'archived']);
    expect(dataLakeKeys.deleted).toEqual(['data-lakes', 'deleted']);
    expect(dataLakeKeys.activeBatches).toEqual(['data-lake-batches', 'active']);
  });

  it('per-lake files: query key, per-lake invalidation prefix, global root', () => {
    expect(dataLakeKeys.files('lake1', { limit: 100 })).toEqual(['dataLakeFiles', 'lake1', { limit: 100 }]);
    expect(dataLakeKeys.files('lake1', undefined)).toEqual(['dataLakeFiles', 'lake1', undefined]);
    expect(dataLakeKeys.filesOf('lake1')).toEqual(['dataLakeFiles', 'lake1']);
    expect(dataLakeKeys.filesRoot).toEqual(['dataLakeFiles']);
  });

  it('browse surfaces keyed by source discriminator', () => {
    expect(dataLakeKeys.tagCounts('opti')).toEqual(['dataLakeTagCounts', 'opti']);
    expect(dataLakeKeys.tagCountsRoot).toEqual(['dataLakeTagCounts']);
    expect(dataLakeKeys.articles('datalakes', { page: 1 })).toEqual(['dataLakeArticles', 'datalakes', { page: 1 }]);
    expect(dataLakeKeys.articlesRoot).toEqual(['dataLakeArticles']);
  });
});
