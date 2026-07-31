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

function optionsArgOf(searchMock: Mock) {
  return searchMock.mock.calls[0][5] as Record<string, unknown>;
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

/**
 * Every option that widens which files a search returns reaches an arm of
 * buildOwnershipConditions that relaxes ownership - dataLakeTagPrefixes is an un-ANDed bypass, and
 * restrictToDataLake drops the ownership arms outright. They are therefore server-supplied only,
 * and this is the layer where that boundary exists: params are zod-parsed from request input,
 * serverOptions are not. The hostile VALUES are asserted, not just the shape, because a scope that
 * arrives under a different key is the failure being guarded against.
 */
describe('fabFileService search - the access scope cannot come from request input', () => {
  // `datalake:` is the namespace every lake's membership meta-tag lives in, so honoring it as a
  // prefix would match every data-lake file in the database regardless of owner or tenant.
  const HOSTILE = {
    includeShared: true,
    userGroups: ['some-group-the-caller-is-not-in'],
    dataLakeTags: ['datalake:someone-else:private'],
    dataLakeTagPrefixes: ['datalake:'],
    scopedTagPrefixes: ['acme:'],
    restrictToDataLake: true,
  };

  it('drops every scope key a caller puts in params.options', async () => {
    const { adapters: a, fabFilesSearch } = adapters();

    // any: the point is a payload the parsed type no longer admits.
    await search('u1', { options: HOSTILE } as any, a);

    const options = optionsArgOf(fabFilesSearch);
    expect(options.dataLakeTagPrefixes).toBeUndefined();
    expect(options.scopedTagPrefixes).toBeUndefined();
    expect(options.dataLakeTags).toBeUndefined();
    expect(options.userGroups).toBeUndefined();
    expect(options.restrictToDataLake).toBeUndefined();
    expect(options.includeShared).toBe(false);
    // Nothing hostile survived under any key.
    expect(JSON.stringify(options)).not.toContain('datalake:');
    expect(JSON.stringify(options)).not.toContain('acme:');
  });

  it('still honors the presentation options a caller is allowed to set', async () => {
    const { adapters: a, fabFilesSearch } = adapters();

    await search('u1', { options: { textSearch: true, excludeContent: true } }, a);

    const options = optionsArgOf(fabFilesSearch);
    expect(options.textSearch).toBe(true);
    expect(options.excludeContent).toBe(true);
  });

  it('passes the same scope through when the SERVER supplies it', async () => {
    const { adapters: a, fabFilesSearch } = adapters();

    await search('u1', {}, a, {
      includeShared: true,
      userGroups: ['group-a'],
      dataLakeTags: ['datalake:org1:handbook'],
      dataLakeTagPrefixes: ['acme:'],
      scopedTagPrefixes: ['docs:'],
      restrictToDataLake: true,
    });

    const options = optionsArgOf(fabFilesSearch);
    expect(options.includeShared).toBe(true);
    expect(options.userGroups).toEqual(['group-a']);
    expect(options.dataLakeTags).toEqual(['datalake:org1:handbook']);
    expect(options.dataLakeTagPrefixes).toEqual(['acme:']);
    expect(options.scopedTagPrefixes).toEqual(['docs:']);
    expect(options.restrictToDataLake).toBe(true);
  });

  // A caller-supplied value must not win over the server's, whichever way a future merge is written.
  it('lets the server scope stand even when params carry a conflicting one', async () => {
    const { adapters: a, fabFilesSearch } = adapters();

    await search('u1', { options: HOSTILE } as any, a, { includeShared: true, dataLakeTags: ['datalake:org1:mine'] });

    const options = optionsArgOf(fabFilesSearch);
    expect(options.dataLakeTags).toEqual(['datalake:org1:mine']);
    expect(options.dataLakeTagPrefixes).toBeUndefined();
  });

  it('searches owner-only when neither side supplies a scope', async () => {
    const { adapters: a, fabFilesSearch } = adapters();

    await search('u1', {}, a);

    const options = optionsArgOf(fabFilesSearch);
    expect(options.includeShared).toBe(false);
    expect(options.userGroups).toBeUndefined();
    expect(options.dataLakeTags).toBeUndefined();
  });
});
