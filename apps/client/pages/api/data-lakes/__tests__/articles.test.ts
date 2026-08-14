// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockResolveAccessibleLakes, mockQueryDataLakeArticles, mockRecord } = vi.hoisted(() => ({
  mockResolveAccessibleLakes: vi.fn(),
  mockQueryDataLakeArticles: vi.fn(),
  mockRecord: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain: Record<string, unknown> = {};
    chain.use = () => chain;
    chain.get = (fn: unknown) => fn;
    return chain;
  },
}));
vi.mock('@server/dataLakes', async () => ({
  resolveAccessibleLakes: mockResolveAccessibleLakes,
  queryDataLakeArticles: mockQueryDataLakeArticles,
  // Real implementation (already unit-tested on its own) so the deep-link attribution test below
  // asserts on the actual predicate rather than a reimplementation. Imported from its own
  // lightweight file, not `importOriginal` of this whole barrel - the barrel pulls in
  // toAccessContext's entitlements/Subscription-model chain, which this test does not mock.
  grantingLakes: (await import('../../../../server/dataLakes/grantingLakes')).grantingLakes,
}));
vi.mock('@bike4mind/database', () => ({
  lakeAccessEventRepository: { record: mockRecord },
  adminSettingsRepository: {
    findBySettingNames: vi.fn().mockResolvedValue([]),
    findAll: vi.fn().mockResolvedValue([]),
  },
}));
vi.mock('@bike4mind/services', async () => ({
  dataLakeService: {
    attributeAccessedLakeIds: (
      await import('../../../../../../b4m-core/services/src/dataLakeService/attributeAccessedLakes')
    ).attributeAccessedLakeIds,
    recordLakeAccessEvent: (
      await import('../../../../../../b4m-core/services/src/dataLakeService/recordLakeAccessEvent')
    ).recordLakeAccessEvent,
  },
}));

import handler from '@pages/api/data-lakes/articles';

type RouteHandler = (req: unknown, res: unknown) => Promise<unknown>;
const route = handler as unknown as RouteHandler;

const LAKES = [
  { id: 'lake1', datalakeTag: 'datalake:lake1' },
  { id: 'lake2', datalakeTag: 'datalake:lake2' },
];

const makeReq = (query: Record<string, string> = {}, user: Record<string, unknown> = { id: 'u1' }) => ({
  query,
  user,
  logger: { warn: vi.fn(), error: vi.fn() },
});

const makeRes = () => {
  const json = vi.fn();
  return { json, res: { json } as never };
};

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveAccessibleLakes.mockResolvedValue(LAKES);
});

describe('GET /api/data-lakes/articles access-event audit', () => {
  it('records an event attributed to the tag-matched lake(s) among the returned files', async () => {
    mockQueryDataLakeArticles.mockResolvedValue({
      data: [{ id: 'f1', tags: [{ name: 'datalake:lake1' }] }],
      total: 1,
      hasMore: false,
    });
    const { res } = makeRes();

    await route(makeReq({ search: 'onboarding' }), res);

    expect(mockRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        principalKind: 'user',
        principalId: 'u1',
        resolvedLakeIds: ['lake1'],
        fileIds: ['f1'],
        surface: 'data-lake-articles',
        queryText: 'onboarding',
      })
    );
  });

  it('narrows a repeated ?search= (Express hands back an array) to its first value', async () => {
    mockQueryDataLakeArticles.mockResolvedValue({
      data: [{ id: 'f1', tags: [{ name: 'datalake:lake1' }] }],
      total: 1,
      hasMore: false,
    });

    await route(makeReq({ search: ['onboarding', 'other'] as unknown as string }), makeRes().res);

    expect(mockRecord).toHaveBeenCalledWith(expect.objectContaining({ queryText: 'onboarding' }));
  });

  // The list/search path is a MIXED corpus (owned + shared + org-shared + data lake, since this
  // route never sets restrictToDataLake) - a hit with no recoverable tag may be the caller's own
  // private file, so this must NOT fall back to the full scope, unlike the deep-link case below.
  it('does not record when no returned file carries a datalake tag (mixed corpus, no fallback)', async () => {
    mockQueryDataLakeArticles.mockResolvedValue({
      data: [{ id: 'f1', tags: [{ name: 'opti:policy' }] }],
      total: 1,
      hasMore: false,
    });

    await route(makeReq(), makeRes().res);

    expect(mockRecord).not.toHaveBeenCalled();
  });

  // The deep-link (?id=) branch's own attribution narrowing (grantingLakes, naming the specific
  // grantor rather than falling back to the full scope) is unit-tested directly against the real
  // implementation in queryDataLakeArticles.test.ts - this route mocks queryDataLakeArticles
  // wholesale, so it only needs to prove the route reuses `result.grantedLakeIds` as-is rather
  // than recomputing it (or dropping it) on the way into the audit write.
  it('reuses grantedLakeIds from queryDataLakeArticles for the deep-link attribution', async () => {
    mockQueryDataLakeArticles.mockResolvedValue({
      data: [{ id: 'f1', tags: [{ name: 'opti:policy' }] }],
      total: 1,
      hasMore: false,
      grantedLakeIds: ['opti-knowledge'],
    });

    await route(makeReq({ id: 'f1' }), makeRes().res);

    expect(mockRecord).toHaveBeenCalledWith(expect.objectContaining({ resolvedLakeIds: ['opti-knowledge'] }));
  });

  it('does not record an event when nothing was returned', async () => {
    mockQueryDataLakeArticles.mockResolvedValue({ data: [], total: 0, hasMore: false });

    await route(makeReq(), makeRes().res);

    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('still returns the response when the audit write rejects', async () => {
    mockQueryDataLakeArticles.mockResolvedValue({ data: [{ id: 'f1', tags: [] }], total: 1, hasMore: false });
    mockRecord.mockRejectedValueOnce(new Error('mongo blip'));
    const { res, json } = makeRes();

    await route(makeReq(), res);

    expect(json).toHaveBeenCalledWith({ data: [{ id: 'f1', tags: [] }], total: 1, hasMore: false });
  });
});
