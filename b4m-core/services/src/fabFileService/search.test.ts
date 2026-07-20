import { describe, it, expect, vi, type Mock } from 'vitest';
import { search } from './search';

// The ids/projectId filters express restriction ("only these files"), and used to be fed
// into the fileIds EXCLUSION filter - inverting them. These tests pin the corrected mapping
// onto restrictToFileIds, including the fail-closed empty scope for an unresolvable project.
function adapters(project: { fileIds: string[] } | null = null) {
  const fabFilesSearch = vi.fn().mockResolvedValue({ data: [], hasMore: false, total: 0 });
  return {
    adapters: {
      db: {
        fabFiles: { search: fabFilesSearch },
        projects: { findById: vi.fn().mockResolvedValue(project) },
        // any: signed-url generation is not reached with an empty result set.
        users: { findById: vi.fn() } as any,
      },
      storage: { generateSignedUrl: vi.fn() },
    } as any,
    fabFilesSearch,
  };
}

function filtersArgOf(searchMock: Mock) {
  return searchMock.mock.calls[0][2] as Record<string, unknown>;
}

describe('fabFileService search - restriction filters', () => {
  it('maps filters.ids onto the restrictToFileIds allow-list, not the fileIds exclusion', async () => {
    const { adapters: a, fabFilesSearch } = adapters();

    await search('u1', { filters: { ids: ['a', 'b'] } }, a);

    const filters = filtersArgOf(fabFilesSearch);
    expect(filters.restrictToFileIds).toEqual(['a', 'b']);
    expect(filters.fileIds).toBeUndefined();
  });

  it('maps projectId onto restrictToFileIds = the project file set', async () => {
    const { adapters: a, fabFilesSearch } = adapters({ fileIds: ['p1', 'p2'] });

    await search('u1', { filters: { projectId: 'proj-1' } }, a);

    expect(filtersArgOf(fabFilesSearch).restrictToFileIds).toEqual(['p1', 'p2']);
  });

  it('fail-closed: a project that cannot be found restricts to [] instead of searching unscoped', async () => {
    const { adapters: a, fabFilesSearch } = adapters(null);

    await search('u1', { filters: { projectId: 'missing' } }, a);

    expect(filtersArgOf(fabFilesSearch).restrictToFileIds).toEqual([]);
  });

  it('fail-closed: a project with no files restricts to []', async () => {
    const { adapters: a, fabFilesSearch } = adapters({ fileIds: [] });

    await search('u1', { filters: { projectId: 'empty' } }, a);

    expect(filtersArgOf(fabFilesSearch).restrictToFileIds).toEqual([]);
  });

  it('no ids and no projectId leaves the search unrestricted', async () => {
    const { adapters: a, fabFilesSearch } = adapters();

    await search('u1', {}, a);

    expect(filtersArgOf(fabFilesSearch).restrictToFileIds).toBeUndefined();
  });
});
