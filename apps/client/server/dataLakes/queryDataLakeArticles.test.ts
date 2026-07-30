import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The multi-lake browse resolves its own scope from the lakes the caller can reach and hands it to
 * fabFilesService.search. Every value in that scope reaches an ownership arm, so it is passed in
 * the server-only argument rather than the zod-parsed params - and because both are plain objects,
 * dropping one in the move would silently change what the Explorer lists with nothing failing.
 * These pin the split: what goes where, and that the query string cannot contribute to either.
 */

const h = vi.hoisted(() => ({
  search: vi.fn(),
  isFallbackLake: vi.fn(),
}));

vi.mock('@bike4mind/services', () => ({
  fabFilesService: { search: h.search },
  dataLakeService: { isFallbackLake: h.isFallbackLake, listDataLakes: vi.fn(), listAllDataLakes: vi.fn() },
}));

// Spread the real module: the barrel re-exports mongoose and much else that the import chain
// pulls in, and a bare object mock only surfaces that as an unrelated "no export defined" error.
vi.mock('@bike4mind/database', async () => {
  const actual = await vi.importActual<typeof import('@bike4mind/database')>('@bike4mind/database');
  return {
    ...actual,
    fabFileRepository: {
      findById: vi.fn(),
      countDataLakeTagsByPrefix: vi.fn(),
      countDataLakeUniqueFilesByPrefix: vi.fn(),
    },
  };
});

vi.mock('@server/utils/storage', () => ({ getFilesStorage: () => ({ getSignedUrl: vi.fn() }) }));

import { queryDataLakeArticles } from './index';

// `STATIC_LAKE_IDS` decides which prefixes are the OPEN (ownership-bypassing) arm, so the fixture
// uses a lake id that is NOT in the static registry - its prefix must land on the scoped arm.
const DYNAMIC_LAKE = {
  id: 'dyn-lake-1',
  datalakeTag: 'datalake:org1:handbook',
  fileTagPrefix: 'handbook:',
} as any;

const req = { user: { id: 'viewer-9', groups: ['group-a'], tags: ['Opti'] } } as any;

const callArgs = () => {
  const [, params, , serverOptions] = h.search.mock.calls[0];
  return { params, serverOptions };
};

describe('queryDataLakeArticles scope plumbing', () => {
  beforeEach(() => {
    h.search.mockReset();
    h.search.mockResolvedValue({ data: [], total: 0, hasMore: false });
  });

  it('passes the whole access scope in the server-only argument, not the parsed params', async () => {
    await queryDataLakeArticles(req, [DYNAMIC_LAKE], {} as any);

    const { params, serverOptions } = callArgs();
    expect(serverOptions).toMatchObject({
      includeShared: true,
      userGroups: ['group-a'],
      dataLakeTags: ['datalake:org1:handbook'],
      scopedTagPrefixes: ['handbook:'],
    });
    // Nothing that widens access may sit in params - search() zod-parses those from request input.
    for (const key of [
      'includeShared',
      'userGroups',
      'dataLakeTags',
      'dataLakeTagPrefixes',
      'scopedTagPrefixes',
      'restrictToDataLake',
    ]) {
      expect(params.options).not.toHaveProperty(key);
    }
  });

  it('keeps the presentation options in the parsed params', async () => {
    await queryDataLakeArticles(req, [DYNAMIC_LAKE], { search: 'handbook' } as any);

    expect(callArgs().params.options).toEqual({ textSearch: true, excludeContent: true });
  });

  // A dynamic lake's fileTagPrefix is user-chosen and can collide across tenants, so it must reach
  // the scoped arm (ANDed with ownership) and never the open one (an un-ANDed bypass).
  it('routes a dynamic lake prefix to the scoped arm, leaving the open arm empty', async () => {
    await queryDataLakeArticles(req, [DYNAMIC_LAKE], {} as any);

    const { serverOptions } = callArgs();
    expect(serverOptions.scopedTagPrefixes).toEqual(['handbook:']);
    expect(serverOptions.dataLakeTagPrefixes).toEqual([]);
  });

  it('cannot have its scope influenced by the query string', async () => {
    await queryDataLakeArticles(req, [DYNAMIC_LAKE], {
      dataLakeTagPrefixes: ['datalake:'],
      scopedTagPrefixes: ['acme:'],
      userGroups: ['a-group-the-caller-is-not-in'],
      includeShared: 'true',
    } as any);

    const { serverOptions } = callArgs();
    // The bare `datalake:` prefix would match every lake's meta-tag in the database; the only
    // legitimate datalake: string here is this caller's own resolved meta-tag.
    expect(serverOptions.dataLakeTagPrefixes).toEqual([]);
    expect(serverOptions.dataLakeTags).toEqual(['datalake:org1:handbook']);
    expect(serverOptions.scopedTagPrefixes).toEqual(['handbook:']);
    expect(serverOptions.userGroups).toEqual(['group-a']);
    expect(JSON.stringify(callArgs())).not.toContain('a-group-the-caller-is-not-in');
    expect(JSON.stringify(callArgs())).not.toContain('acme:');
  });

  it('returns an empty page without searching when no lake is accessible', async () => {
    const result = await queryDataLakeArticles(req, [], {} as any);

    expect(result).toEqual({ data: [], total: 0, hasMore: false });
    expect(h.search).not.toHaveBeenCalled();
  });
});
