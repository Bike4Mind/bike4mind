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
  facetResult: null as any,
  cacheWriteError: null as null | Error,
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
    createOrUpdate: vi.fn(async () => {
      if (mockRefs.cacheWriteError) throw mockRefs.cacheWriteError;
    }),
  },
  convertPipelineForDocumentDB: (p: any) => p,
  executeFacetCompatible: (_model: any, _pipeline: any, facetStages: any) => {
    mockRefs.facetStages = facetStages;
    return Promise.resolve([
      mockRefs.facetResult ?? { rows: [{ date: '2026-07-28', counterName: 'Login' }], total: [{ value: 42 }] },
    ]);
  },
}));

vi.mock('@bike4mind/observability', () => ({ Logger: class {} }));
vi.mock('@bike4mind/services', () => ({ counterService: {} }));
vi.mock('@client/services/operationsModelService', () => ({
  OperationsModelService: { getOperationsModel: vi.fn() },
  getEffectiveApiKeyByBackend: vi.fn(),
}));

import '@pages/api/users/counterLogs';
import { MAX_CACHED_ROWS } from '@server/analytics/userActivityCache';

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
    mockRefs.facetResult = null;
    mockRefs.cacheWriteError = null;
  });

  it('returns one page plus the total instead of every matching row', async () => {
    const { req, res } = mocks({ ...DATES, page: '1', limit: '10' });

    await mockRefs.getHandler!(req, res);

    expect(res._getJSONData()).toEqual({
      logs: [{ date: '2026-07-28', counterName: 'Login' }],
      total: 42,
      page: 1,
      limit: 10,
    });
  });

  it('slices the requested page out of the window it just materialized', async () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({ date: '2026-07-28', counterName: `c${i}` }));
    mockRefs.facetResult = { rows, total: [{ value: 30 }] };
    const { req, res } = mocks({ ...DATES, page: '3', limit: '10' });

    await mockRefs.getHandler!(req, res);

    expect(stageValue('$skip'), 'the window itself always starts at 0').toBe(0);
    expect(res._getJSONData()).toMatchObject({ logs: rows.slice(20, 30), total: 30, page: 3 });
  });

  it('defaults to the first page, skipping nothing', async () => {
    const { req, res } = mocks(DATES);

    await mockRefs.getHandler!(req, res);

    expect(res._getJSONData()).toMatchObject({ page: 1, total: 42 });
    expect(stageValue('$skip')).toBe(0);
  });

  it('reports a zero total when the facet matched nothing', async () => {
    mockRefs.facetResult = { rows: [], total: [] };
    const { req, res } = mocks(DATES);

    await mockRefs.getHandler!(req, res);

    expect(res._getJSONData()).toMatchObject({ logs: [], total: 0 });
  });

  it('still answers when the cache write fails', async () => {
    // The pre-pagination 17.8MB result exceeded Mongo's 16MB BSON limit, so this write threw on
    // every single request. A caching failure must never become a failed response.
    mockRefs.cacheWriteError = new Error('BSONObjectTooLarge');
    const { req, res } = mocks(DATES);

    await mockRefs.getHandler!(req, res);

    expect(res._getJSONData()).toMatchObject({ total: 42 });
  });

  it('clamps an oversized page request so one page can never exceed the Lambda cap', async () => {
    const { req, res } = mocks({ ...DATES, limit: '100000' });

    await mockRefs.getHandler!(req, res);

    expect(res._getJSONData().limit).toBe(5000);
    // The window read ahead of the page is bounded too - it is held in Lambda memory and written
    // to a single cache document.
    expect(stageValue('$limit')).toBeLessThanOrEqual(MAX_CACHED_ROWS);
  });

  it.each(['', 'not-a-date', '2026-13-01', '2026-02-30'])(
    'rejects the date %j instead of widening the window to all time',
    async (startDate: string) => {
      // An unparseable date became an Invalid Date, which serializes to epoch 0 - so the query
      // silently scanned the whole collection rather than the week the caller asked for.
      const { req, res } = mocks({ ...DATES, startDate });

      await expect(mockRefs.getHandler!(req, res)).rejects.toMatchObject({ statusCode: 400 });
      expect(mockRefs.facetStages).toBeUndefined();
    }
  );

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

  it('shares one cache entry across the pages of a filter set', async () => {
    // Page-scoped keys meant browsing N pages cost N full aggregations, because $skip/$limit only
    // trims a result the pipeline has already materialized.
    const first = mocks({ ...DATES, page: '1', limit: '10' });
    await mockRefs.getHandler!(first.req, first.res);
    const second = mocks({ ...DATES, page: '2', limit: '10' });
    await mockRefs.getHandler!(second.req, second.res);

    expect(mockRefs.cacheKeys[0]).toBe(mockRefs.cacheKeys[1]);
  });

  it('materializes a window past the requested page so later pages need no aggregation', async () => {
    const { req, res } = mocks({ ...DATES, page: '1', limit: '10' });

    await mockRefs.getHandler!(req, res);

    expect(stageValue('$skip')).toBe(0);
    expect(stageValue('$limit')).toBeGreaterThan(10);
  });

  it('slices a later page out of the cached window instead of re-aggregating', async () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({ date: '2026-07-28', counterName: `c${i}` }));
    mockRefs.cached = { result: { rows, total: 30, truncated: false } };
    const { req, res } = mocks({ ...DATES, page: '3', limit: '10' });

    await mockRefs.getHandler!(req, res);

    expect(mockRefs.facetStages, 'no aggregation should have run').toBeUndefined();
    expect(res._getJSONData()).toMatchObject({ logs: rows.slice(20, 30), total: 30, page: 3 });
  });

  it('answers a page past the end of a fully cached result set without re-aggregating', async () => {
    mockRefs.cached = { result: { rows: [{ date: '2026-07-28' }], total: 1, truncated: false } };
    const { req, res } = mocks({ ...DATES, page: '9', limit: '10' });

    await mockRefs.getHandler!(req, res);

    expect(mockRefs.facetStages).toBeUndefined();
    expect(res._getJSONData()).toMatchObject({ logs: [], total: 1 });
  });

  it('fetches just the page when it lies past a window the byte budget cut short', async () => {
    // Re-materializing the window would return the same truncated prefix, so the page would never
    // be reachable - and each attempt would pay for the larger fetch.
    mockRefs.cached = { result: { rows: [{ date: '2026-07-28' }], total: 9000, truncated: true } };
    const { req, res } = mocks({ ...DATES, page: '3', limit: '10' });

    await mockRefs.getHandler!(req, res);

    expect(stageValue('$skip')).toBe(20);
    expect(stageValue('$limit')).toBe(10);
  });

  it('keeps two filter sets apart when a search term contains the key delimiter', async () => {
    // Unencoded, ':' in free text shifts the boundary: counterName='a:b' + userEmail='c' and
    // counterName='a' + userEmail='b:c' built the same key, so one admin was served the other's
    // rows and total for the full hour.
    const first = mocks({ ...DATES, counterName: 'a:b', userEmail: 'c' });
    await mockRefs.getHandler!(first.req, first.res);
    const second = mocks({ ...DATES, counterName: 'a', userEmail: 'b:c' });
    await mockRefs.getHandler!(second.req, second.res);

    expect(mockRefs.cacheKeys[0]).not.toBe(mockRefs.cacheKeys[1]);
  });

  it('rejects a page number too large to skip to', async () => {
    const { req, res } = mocks({ ...DATES, page: '1e20' });

    await expect(mockRefs.getHandler!(req, res)).rejects.toMatchObject({ statusCode: 400 });
  });

  it('surfaces which parameter was rejected instead of a bare message', async () => {
    // errorHandler spreads additionalInfo and then writes its own `error`, so the detail has to
    // travel under a different key or the admin never learns which filter was refused.
    const { req, res } = mocks({ ...DATES, metadataFilters: JSON.stringify([{ field: '', operator: 'exists' }]) });

    await expect(mockRefs.getHandler!(req, res)).rejects.toMatchObject({
      statusCode: 400,
      additionalInfo: { issues: expect.any(Array) },
    });
  });

  it('keeps the cached envelope shape when it serves a cache hit', async () => {
    mockRefs.cached = { result: { rows: [{ date: '2026-07-27', counterName: 'Logout' }], total: 1, truncated: false } };
    const { req, res } = mocks({ ...DATES, page: '1', limit: '10' });

    await mockRefs.getHandler!(req, res);

    expect(res._getJSONData()).toEqual({
      logs: [{ date: '2026-07-27', counterName: 'Logout' }],
      total: 1,
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
