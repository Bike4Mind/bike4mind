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

    const [, params] = h.search.mock.calls[0];
    // search() zod-parses params; a forgeable creatorUserId there would read anyone's files.
    expect(params.options).not.toHaveProperty('lakeMembership');
    // The superseded per-viewer lake arms are gone, so the two predicates cannot drift.
    expect(params.options).not.toHaveProperty('scopedTagPrefixes');
    expect(params.options).not.toHaveProperty('dataLakeTags');
    expect(params.options.restrictToDataLake).toBe(true);
  });

  it('still returns an empty page for a lake with no meta-tag, without searching', async () => {
    h.assertLakeAccess.mockResolvedValue({ ...LAKE, datalakeTag: '' });
    const { res, json } = makeRes();

    await (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(makeReq(), res);

    expect(json).toHaveBeenCalledWith({ data: [], total: 0, hasMore: false });
    expect(h.search).not.toHaveBeenCalled();
  });
});
