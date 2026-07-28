import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * The User Activity feed returned every matching row unpaginated, which reached ~17MB on
 * production data and tripped Lambda's 6MB response cap (413 -> CloudFront 502 -> the UI's
 * catch-all rendering "No data found"). These guard the paging envelope that replaced it.
 *
 * Separate from counterLogs.test.ts because these mock @bike4mind/database wholesale to inspect
 * the facet stages and cache keys, which is incompatible with that file's real-Mongo harness.
 */

// `any` below is deliberate test-mock plumbing: typing the full next-connect /
// node-mocks-http chain adds no coverage value (matches the repo's handler-test convention).
/* eslint-disable @typescript-eslint/no-explicit-any */
const mockRefs = vi.hoisted(() => ({
  getHandler: null as null | ((req: any, res: any) => unknown),
  facetStages: undefined as any,
  cacheKeys: [] as string[],
  cached: null as any,
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = {
    use: () => chain,
    get: (fn: any) => {
      mockRefs.getHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});

vi.mock('@bike4mind/database', () => ({
  CounterLog: { collection: { name: 'counterlogs' }, aggregate: vi.fn().mockResolvedValue([]) },
  User: { collection: { name: 'users' } },
  DailyReport: { find: vi.fn().mockResolvedValue([]) },
  dailyReportRepository: { upsertReport: vi.fn() },
  weeklyReportRepository: { findByDateRange: vi.fn(), upsertReport: vi.fn() },
  counterLogRepository: {},
  cacheRepository: {
    findByKey: vi.fn(async (key: string) => {
      mockRefs.cacheKeys.push(key);
      return mockRefs.cached;
    }),
    createOrUpdate: vi.fn(),
  },
  convertPipelineForDocumentDB: (p: any) => p,
  executeFacetCompatible: (_model: any, _pipeline: any, facetStages: any) => {
    mockRefs.facetStages = facetStages;
    return Promise.resolve([{ rows: [{ date: '2026-07-28', counterName: 'Login' }], total: [{ value: 42 }] }]);
  },
}));

vi.mock('@bike4mind/observability', () => ({ Logger: class {} }));
vi.mock('@bike4mind/services', () => ({ counterService: {} }));
vi.mock('@client/services/operationsModelService', () => ({
  OperationsModelService: { getOperationsModel: vi.fn() },
  getEffectiveApiKeyByBackend: vi.fn(),
}));

import '@pages/api/users/counterLogs';

const DATES = { startDate: '2026-07-21', endDate: '2026-07-28' };

function mocks(query: Record<string, unknown>, canRead = true) {
  const { req, res } = createMocks({ method: 'GET', query });
  (req as any).user = { id: 'u1' };
  (req as any).ability = { can: () => canRead };
  // baseApi attaches this in the app; sendMaybeGzip (the sole response sender) requires it.
  const logger: Record<string, unknown> = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  logger.withMetadata = vi.fn(() => logger);
  (req as any).logger = logger;
  return { req, res };
}

const stageValue = (name: string) => mockRefs.facetStages.rows.find((s: any) => name in s)?.[name];

describe('GET /api/users/counterLogs - user activity paging', () => {
  beforeEach(() => {
    mockRefs.facetStages = undefined;
    mockRefs.cacheKeys = [];
    mockRefs.cached = null;
  });

  it('returns one page plus the total instead of every matching row', async () => {
    const { req, res } = mocks({ ...DATES, page: '2', limit: '10' });

    await mockRefs.getHandler!(req, res);

    expect(res._getJSONData()).toEqual({
      logs: [{ date: '2026-07-28', counterName: 'Login' }],
      total: 42,
      page: 2,
      limit: 10,
    });
  });

  it('reports a zero total when the facet matched nothing', async () => {
    const { req, res } = mocks(DATES);

    await mockRefs.getHandler!(req, res);

    expect(res._getJSONData().total).toBe(42);
    expect(stageValue('$skip')).toBe(0);
  });

  it('clamps an oversized page request so one page can never exceed the Lambda cap', async () => {
    const { req, res } = mocks({ ...DATES, limit: '100000' });

    await mockRefs.getHandler!(req, res);

    expect(stageValue('$limit')).toBe(5000);
    expect(res._getJSONData().limit).toBe(5000);
  });

  it('rejects a non-positive page rather than skipping a negative number of rows', async () => {
    const { req, res } = mocks({ ...DATES, page: '0' });

    await expect(mockRefs.getHandler!(req, res)).rejects.toMatchObject({ statusCode: 400 });
  });

  it('rejects a metadata filter whose field name could inject a Mongo operator', async () => {
    const { req, res } = mocks({
      ...DATES,
      metadataFilters: JSON.stringify([{ field: '$where', operator: 'exists' }]),
    });

    await expect(mockRefs.getHandler!(req, res)).rejects.toMatchObject({ statusCode: 400 });
  });

  it('caches each page under its own key so page 2 cannot serve page 1', async () => {
    const first = mocks({ ...DATES, page: '1', limit: '10' });
    await mockRefs.getHandler!(first.req, first.res);
    const second = mocks({ ...DATES, page: '2', limit: '10' });
    await mockRefs.getHandler!(second.req, second.res);

    expect(mockRefs.cacheKeys[0]).not.toBe(mockRefs.cacheKeys[1]);
  });

  it('keeps the cached envelope shape when it serves a cache hit', async () => {
    mockRefs.cached = { result: { rows: [{ date: '2026-07-27', counterName: 'Logout' }], total: 7 } };
    const { req, res } = mocks({ ...DATES, page: '1', limit: '10' });

    await mockRefs.getHandler!(req, res);

    expect(res._getJSONData()).toEqual({
      logs: [{ date: '2026-07-27', counterName: 'Logout' }],
      total: 7,
      page: 1,
      limit: 10,
    });
  });

  it('refuses a caller without CounterLog read permission', async () => {
    const { req, res } = mocks(DATES, false);

    await expect(mockRefs.getHandler!(req, res)).rejects.toThrow();
    expect(mockRefs.facetStages).toBeUndefined();
  });
});
