import { describe, it, expect, vi, beforeEach } from 'vitest';

const LAKE = {
  id: 'lake1',
  datalakeTag: 'datalake:org1:acme-docs',
  fileTagPrefix: 'acme:',
  createdByUserId: 'creator-1',
};

const h = vi.hoisted(() => ({
  assertLakeAccess: vi.fn(),
  lakeMembershipScope: vi.fn(),
  isFallbackLake: vi.fn(),
  search: vi.fn(),
  toAccessContext: vi.fn(async () => ({ userId: 'viewer-9', isAdmin: false })),
  record: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const routes: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign((req: { method?: string }, res: unknown) => routes[req.method ?? 'GET']?.(req, res), {
      use: () => chain,
      get: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((routes.GET = fns[fns.length - 1]), chain),
    });
    return chain;
  },
}));
vi.mock('@server/middlewares/featureFlag', () => ({ requireFeatureEnabled: () => () => {} }));
vi.mock('@bike4mind/services', async () => ({
  dataLakeService: {
    assertLakeAccess: h.assertLakeAccess,
    lakeMembershipScope: h.lakeMembershipScope,
    isFallbackLake: h.isFallbackLake,
    // Real implementation (already unit-tested on its own) so this suite asserts on the actual
    // lakeAccessEventRepository.record call args rather than a reimplementation.
    recordLakeAccessEvent: (
      await import('../../../../../../../b4m-core/services/src/dataLakeService/recordLakeAccessEvent')
    ).recordLakeAccessEvent,
  },
  fabFilesService: { search: h.search },
}));
vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  dataLakeRepository: {},
  dataLakeAccessGrantRepository: {
    listByLake: vi.fn().mockResolvedValue([]),
    listActiveByLakes: vi.fn().mockResolvedValue([]),
    listByPrincipal: vi.fn().mockResolvedValue([]),
    findGrant: vi.fn().mockResolvedValue(null),
    upsertGrant: vi.fn().mockResolvedValue({}),
    removeGrant: vi.fn().mockResolvedValue(true),
    removeAllForLake: vi.fn().mockResolvedValue(0),
  },
  fabFileRepository: {},
  projectRepository: {},
  userRepository: { findById: vi.fn() },
  lakeAccessEventRepository: { record: h.record },
}));
vi.mock('@server/dataLakes/toAccessContext', () => ({ toAccessContext: h.toAccessContext }));
vi.mock('@server/utils/storage', () => ({ getFilesStorage: () => ({ getSignedUrl: vi.fn() }) }));

import handler from '../articles';

const makeReq = () => ({
  method: 'GET',
  query: { id: 'lake1' },
  user: { id: 'viewer-9', groups: ['viewer-group'] },
  logger: { warn: vi.fn(), error: vi.fn() },
});

const makeRes = () => {
  const json = vi.fn();
  return { res: { json, status: vi.fn(() => ({ json })) } as never, json };
};

beforeEach(() => {
  vi.clearAllMocks();
  h.assertLakeAccess.mockResolvedValue(LAKE);
  h.isFallbackLake.mockReturnValue(false);
  h.lakeMembershipScope.mockReturnValue({
    datalakeTag: LAKE.datalakeTag,
    fileTagPrefix: LAKE.fileTagPrefix,
    creatorUserId: LAKE.createdByUserId,
  });
  h.search.mockResolvedValue({ data: [], total: 0, hasMore: false });
});

describe('GET /api/data-lakes/:id/articles lake scoping', () => {
  it('scopes the browse with the shared membership predicate, anchored to the lake creator', async () => {
    const { res } = makeRes();
    await (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(makeReq(), res);

    expect(h.lakeMembershipScope).toHaveBeenCalledWith(LAKE);
    const [, , , serverOptions] = h.search.mock.calls[0];
    // The creator, NOT the viewer: a viewer's own file that merely carries a colliding tag
    // prefix is not a member of someone else's lake, and a per-viewer answer could never match
    // the lake's persisted fileCount.
    expect(serverOptions.lakeMembership).toEqual({
      datalakeTag: 'datalake:org1:acme-docs',
      fileTagPrefix: 'acme:',
      creatorUserId: 'creator-1',
    });
    expect(serverOptions.lakeMembership.creatorUserId).not.toBe('viewer-9');
  });

  it('passes the scope OUTSIDE the parsed params so a caller cannot forge one', async () => {
    const { res } = makeRes();
    await (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(makeReq(), res);

    const [, params, , serverOptions] = h.search.mock.calls[0];
    // search() zod-parses params; a forgeable creatorUserId there would read anyone's files.
    // Every other scope key is out of the parsed params for the same reason.
    expect(params.options).not.toHaveProperty('lakeMembership');
    expect(params.options).not.toHaveProperty('scopedTagPrefixes');
    expect(params.options).not.toHaveProperty('dataLakeTags');
    expect(params.options).not.toHaveProperty('dataLakeTagPrefixes');
    expect(params.options).not.toHaveProperty('includeShared');
    expect(params.options).not.toHaveProperty('userGroups');
    expect(params.options).not.toHaveProperty('restrictToDataLake');
    // The superseded per-viewer lake arms stay off the server side too, so the two predicates
    // cannot drift; restrictToDataLake is what keeps this to one lake's files.
    expect(serverOptions).not.toHaveProperty('scopedTagPrefixes');
    expect(serverOptions).not.toHaveProperty('dataLakeTags');
    expect(serverOptions.restrictToDataLake).toBe(true);
    // buildFabFileSearchQuery reaches buildOwnershipConditions ONLY when includeShared is true;
    // without it the query falls through to a bare { userId } and restrictToDataLake goes inert,
    // turning this single-lake browse into every file the viewer owns.
    expect(serverOptions.includeShared).toBe(true);
    expect(serverOptions.userGroups).toEqual(['viewer-group']);
  });

  it('browses a built-in registry lake by its OPEN prefix arm, not the ownership predicate', async () => {
    // A fallback lake is owner-less and no write path can stamp its meta-tag, so its files carry
    // only prefixed content tags. Scoping it by creator ownership would return nothing at all.
    h.isFallbackLake.mockReturnValue(true);
    h.assertLakeAccess.mockResolvedValue({ ...LAKE, createdByUserId: '' });
    const { res } = makeRes();

    await (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(makeReq(), res);

    const [, , , serverOptions] = h.search.mock.calls[0];
    expect(serverOptions.dataLakeTagPrefixes).toEqual(['acme:']);
    expect(serverOptions.dataLakeTags).toEqual(['datalake:org1:acme-docs']);
    expect(serverOptions?.lakeMembership).toBeUndefined();
    expect(h.lakeMembershipScope).not.toHaveBeenCalled();
  });

  it('still returns an empty page for a lake with no meta-tag, without searching', async () => {
    h.assertLakeAccess.mockResolvedValue({ ...LAKE, datalakeTag: '' });
    const { res, json } = makeRes();

    await (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(makeReq(), res);

    expect(json).toHaveBeenCalledWith({ data: [], total: 0, hasMore: false });
    expect(h.search).not.toHaveBeenCalled();
  });
});

describe('GET /api/data-lakes/:id/articles access-event audit', () => {
  it('records an event scoped to the resolved lake, with file ids from the result', async () => {
    h.search.mockResolvedValue({ data: [{ id: 'f1' }, { id: 'f2' }], total: 2, hasMore: false });
    const { res } = makeRes();

    await (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(makeReq(), res);

    expect(h.record).toHaveBeenCalledWith(
      expect.objectContaining({
        principalKind: 'user',
        principalId: 'viewer-9',
        resolvedLakeIds: ['lake1'],
        fileIds: ['f1', 'f2'],
        surface: 'data-lake-articles',
      })
    );
  });

  it('narrows a repeated ?search= (Express hands back an array) to its first value', async () => {
    h.search.mockResolvedValue({ data: [{ id: 'f1' }], total: 1, hasMore: false });
    const { res } = makeRes();
    const req = { ...makeReq(), query: { id: 'lake1', search: ['onboarding', 'other'] } };

    await (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res);

    expect(h.record).toHaveBeenCalledWith(expect.objectContaining({ queryText: 'onboarding' }));
  });

  it('does not record an event when the lake has no meta-tag (no search ran)', async () => {
    h.assertLakeAccess.mockResolvedValue({ ...LAKE, datalakeTag: '' });
    const { res } = makeRes();

    await (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(makeReq(), res);

    expect(h.record).not.toHaveBeenCalled();
  });

  // Negative control distinct from the empty-result cases above: here the caller is denied
  // ACCESS outright (assertLakeAccess throws), so the handler never reaches the search or the
  // audit write at all - proving the recorder is skipped on a failed authorization, not merely
  // on an authorized-but-empty read.
  it('does not record an event when the access gate itself denies the request', async () => {
    h.assertLakeAccess.mockRejectedValue(new Error('not found'));
    const { res } = makeRes();

    await expect((handler as unknown as (req: unknown, res: unknown) => Promise<void>)(makeReq(), res)).rejects.toThrow(
      'not found'
    );

    expect(h.search).not.toHaveBeenCalled();
    expect(h.record).not.toHaveBeenCalled();
  });

  it('does not record an event when the search ran but found no files', async () => {
    h.search.mockResolvedValue({ data: [], total: 0, hasMore: false });
    const { res } = makeRes();

    await (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(makeReq(), res);

    expect(h.record).not.toHaveBeenCalled();
  });

  it('still returns the response when the audit write rejects', async () => {
    h.search.mockResolvedValue({ data: [{ id: 'f1' }], total: 1, hasMore: false });
    h.record.mockRejectedValueOnce(new Error('mongo blip'));
    const { res, json } = makeRes();

    await (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(makeReq(), res);

    expect(json).toHaveBeenCalledWith({ data: [{ id: 'f1' }], total: 1, hasMore: false });
  });
});

describe('GET /api/data-lakes/:id/articles pagination walk', () => {
  it('walking page by page over a tied fileName fixture returns exactly total distinct ids', async () => {
    // Simulates a fixed DB layer's tied-fileName total order (see fabFileSearchPageWalk.integration
    // test for the real fix). The walk arithmetic pins page-param parsing, passthrough of
    // data/total/hasMore, and termination; the order assertion at the end is what catches a
    // per-page sort override here, since the mock below reads only pagination.page and would stay
    // green under any sort at all.
    const files = [
      { id: 'f1', fileName: 'd1.txt' },
      { id: 'f2', fileName: 'd2.txt' },
      { id: 'f3', fileName: 'd3.txt' },
      { id: 'f4', fileName: 'tied.txt' },
      { id: 'f5', fileName: 'tied.txt' },
      { id: 'f6', fileName: 'tied.txt' },
      { id: 'f7', fileName: 'tied.txt' },
      { id: 'f8', fileName: 'tied.txt' },
      { id: 'f9', fileName: 'tied.txt' },
      { id: 'f10', fileName: 'z1.txt' },
    ];
    const limit = 3;
    h.search.mockImplementation(async (_userId: string, params: { pagination: { page: number } }) => {
      const skip = (params.pagination.page - 1) * limit;
      const slice = files.slice(skip, skip + limit + 1);
      return { data: slice.slice(0, limit), total: files.length, hasMore: slice.length > limit };
    });

    const seenIds = new Set<string>();
    let duplicateCount = 0;
    let total = -1;
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      const { res, json } = makeRes();
      const req = { ...makeReq(), query: { id: 'lake1', page: String(page), limit: String(limit) } };
      await (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res);

      const response = json.mock.calls[0][0] as { data: Array<{ id: string }>; total: number; hasMore: boolean };
      total = response.total;
      for (const file of response.data) {
        if (seenIds.has(file.id)) duplicateCount++;
        seenIds.add(file.id);
      }
      hasMore = response.hasMore;
      page++;
      // Bounds the walk even if a regression made hasMore never settle.
      if (page > 20) break;
    }

    expect(total).toBe(files.length);
    expect(duplicateCount).toBe(0);
    expect(seenIds.size).toBe(total);
    expect(hasMore).toBe(false);

    // fileName is the only sort buildFabFileSearchQuery gives an _id tiebreaker, so a page walk
    // is only total-ordered while every page asks for it.
    const orders = (h.search.mock.calls as [string, { order: unknown }][]).map(call => call[1].order);
    expect(orders).toEqual(Array(4).fill({ by: 'fileName', direction: 'asc' }));
  });
});
