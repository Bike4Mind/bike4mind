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
vi.mock('@bike4mind/services', () => ({
  dataLakeService: {
    assertLakeAccess: h.assertLakeAccess,
    lakeMembershipScope: h.lakeMembershipScope,
    isFallbackLake: h.isFallbackLake,
  },
  fabFilesService: { search: h.search },
}));
vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  dataLakeRepository: {},
  fabFileRepository: {},
  projectRepository: {},
  userRepository: { findById: vi.fn() },
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
