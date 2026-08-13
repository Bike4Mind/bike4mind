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
vi.mock('@server/dataLakes', () => ({
  resolveAccessibleLakes: mockResolveAccessibleLakes,
  queryDataLakeArticles: mockQueryDataLakeArticles,
}));
vi.mock('@bike4mind/database', () => ({ lakeAccessEventRepository: { record: mockRecord } }));
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

describe('GET /api/data-lakes/articles access-event audit (#1678)', () => {
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

  it('falls back to the full accessible-lake scope when no returned file carries a datalake tag', async () => {
    mockQueryDataLakeArticles.mockResolvedValue({
      data: [{ id: 'f1', tags: [{ name: 'opti:policy' }] }],
      total: 1,
      hasMore: false,
    });

    await route(makeReq(), makeRes().res);

    expect(mockRecord).toHaveBeenCalledWith(expect.objectContaining({ resolvedLakeIds: ['lake1', 'lake2'] }));
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
