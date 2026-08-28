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
  registryMembershipScope: vi.fn(),
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
    registryMembershipScope: h.registryMembershipScope,
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

  it('browses a built-in registry lake through the REGISTRY membership scope', async () => {
    // A registry lake is owner-less, so scoping it by creator ownership drops its prefix arm and
    // under-returns. It used to get a hand-rolled dataLakeTags/dataLakeTagPrefixes pair here; both
    // this browse and the count surfaces now resolve the SAME scope, which is what stops the two
    // from disagreeing about how many files the lake holds.
    const registryScope = { kind: 'registry', datalakeTag: 'datalake:org1:acme-docs', fileTagPrefix: 'acme:' };
    h.isFallbackLake.mockReturnValue(true);
    h.registryMembershipScope.mockReturnValue(registryScope);
    h.assertLakeAccess.mockResolvedValue({ ...LAKE, createdByUserId: '' });
    const { res } = makeRes();

    await (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(makeReq(), res);

    const [, , , serverOptions] = h.search.mock.calls[0];
    expect(serverOptions.lakeMembership).toEqual(registryScope);
    // The hand-rolled pair is gone - leaving it would re-open the second, divergent predicate.
    expect(serverOptions.dataLakeTagPrefixes).toBeUndefined();
    expect(serverOptions.dataLakeTags).toBeUndefined();
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
