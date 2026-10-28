import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ACTIVITY_REPORT_VERSION } from '@bike4mind/common';

/**
 * A failed report used to come back as report text and be cached for an hour, and stored past
 * reports had no version, so a stored "No activity data found" or an outdated format was permanent.
 * Mocks @bike4mind/database wholesale (like counterLogs.paging.test.ts) to see cache and persistence calls.
 */

// `any` below is deliberate test-mock plumbing (matches the repo's handler-test convention).
/* eslint-disable @typescript-eslint/no-explicit-any */
const mockRefs = vi.hoisted(() => ({
  getHandler: null as null | ((req: any, res: any) => unknown),
  storedDaily: [] as any[],
  storedWeekly: null as any,
  datesWithData: [] as string[],
  cacheCalls: [] as Array<{ key: string; result: any; expiresAt: Date }>,
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

const databaseMocks = vi.hoisted(() => ({
  upsertDaily: vi.fn(),
  upsertWeekly: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  CounterLog: {
    collection: { name: 'counterlogs' },
    aggregate: vi.fn(async () => mockRefs.datesWithData.map(_id => ({ _id }))),
  },
  User: { collection: { name: 'users' } },
  DailyReport: { find: vi.fn(async () => mockRefs.storedDaily) },
  dailyReportRepository: { upsertReport: databaseMocks.upsertDaily },
  weeklyReportRepository: {
    findByDateRange: vi.fn(async () => mockRefs.storedWeekly),
    upsertReport: databaseMocks.upsertWeekly,
  },
  counterLogRepository: {},
  cacheRepository: {
    // Behaves like the real cache: a key written earlier is served until it is rewritten.
    findByKey: vi.fn(async (key: string) => mockRefs.cacheCalls.findLast(call => call.key === key)),
    createOrUpdate: vi.fn(async (entry: { key: string; result: unknown; expiresAt: Date }) => {
      mockRefs.cacheCalls.push(entry);
    }),
  },
  convertPipelineForDocumentDB: (p: any) => p,
  executeFacetCompatible: vi.fn(),
}));

const serviceMocks = vi.hoisted(() => ({
  generateDailyReport: vi.fn(),
  formatCustomSlackMessage: vi.fn(() => 'formatted daily report'),
  formatWeeklySlackMessage: vi.fn(() => 'formatted weekly report'),
}));

vi.mock('@bike4mind/observability', () => ({
  Logger: class {
    log() {}
  },
}));
vi.mock('@bike4mind/services', () => ({ counterService: serviceMocks }));
vi.mock('@bike4mind/server-utils/services/operationsModelService', () => ({
  OperationsModelService: { getOperationsModel: vi.fn() },
  getEffectiveApiKeyByBackend: vi.fn(),
}));

import '@pages/api/users/counterLogs';

const TODAY = '2026-08-10';
const PAST_DAY = '2026-07-20';
const PAST_WEEK = { startDate: '2026-07-13', endDate: '2026-07-19' };
const FIVE_MINUTES_MS = 5 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;

const goodMetrics = { metrics: { Login: { count: 3 } }, logs: [] };

function mocks(query: Record<string, unknown>) {
  const { req, res } = createMocks({ method: 'GET', query });
  (req as any).user = { id: 'u1' };
  (req as any).ability = { can: () => true };
  const logger: Record<string, unknown> = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  logger.withMetadata = vi.fn(() => logger);
  (req as any).logger = logger;
  return { req, res };
}

const getDaily = async (date: string) => {
  const { req, res } = mocks({ startDate: date, endDate: date, report: 'true' });
  await mockRefs.getHandler!(req, res);
  return res._getJSONData();
};

describe('GET /api/users/counterLogs - report failures and versioning', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(`${TODAY}T12:00:00.000Z`));
    mockRefs.storedDaily = [];
    mockRefs.storedWeekly = null;
    mockRefs.datesWithData = [PAST_DAY, TODAY];
    mockRefs.cacheCalls = [];
    databaseMocks.upsertDaily.mockReset();
    databaseMocks.upsertWeekly.mockReset();
    serviceMocks.generateDailyReport.mockReset().mockResolvedValue(goodMetrics);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('daily failure', () => {
    it('flags the failed date as an error instead of returning report text', async () => {
      serviceMocks.generateDailyReport.mockRejectedValue(new Error('db down'));

      const body = await getDaily(PAST_DAY);

      expect(body.reports).toEqual([{ date: PAST_DAY, report: '', error: expect.stringContaining('db down') }]);
    });

    it('does not persist or cache the failure, so the next request regenerates', async () => {
      serviceMocks.generateDailyReport.mockRejectedValueOnce(new Error('db down'));

      await getDaily(PAST_DAY);
      expect(databaseMocks.upsertDaily).not.toHaveBeenCalled();
      expect(mockRefs.cacheCalls).toHaveLength(0);

      const second = await getDaily(PAST_DAY);

      expect(serviceMocks.generateDailyReport).toHaveBeenCalledTimes(2);
      expect(second.reports[0]).toMatchObject({ date: PAST_DAY, report: 'formatted daily report' });
      expect(second.reports[0].error).toBeUndefined();
      expect(databaseMocks.upsertDaily).toHaveBeenCalledTimes(1);
    });

    it('does not cache a multi-date response when only one date failed', async () => {
      mockRefs.datesWithData = [PAST_DAY, '2026-07-21'];
      serviceMocks.generateDailyReport
        .mockResolvedValueOnce(goodMetrics)
        .mockRejectedValueOnce(new Error('llm timeout'));
      const { req, res } = mocks({ startDate: PAST_DAY, endDate: '2026-07-21', report: 'true' });

      await mockRefs.getHandler!(req, res);

      const flagged = res._getJSONData().reports.filter((entry: { error?: string }) => entry.error);
      expect(flagged).toHaveLength(1);
      expect(mockRefs.cacheCalls).toHaveLength(0);
    });
  });

  describe('weekly failure', () => {
    it('answers with a 5xx error rather than a report, and caches and persists nothing', async () => {
      mockRefs.storedWeekly = null;
      serviceMocks.generateDailyReport.mockRejectedValue(new Error('db down'));
      const { req, res } = mocks({ ...PAST_WEEK, weeklyReport: 'true' });

      await expect(mockRefs.getHandler!(req, res)).rejects.toMatchObject({ statusCode: 500 });

      expect(databaseMocks.upsertWeekly).not.toHaveBeenCalled();
      expect(mockRefs.cacheCalls).toHaveLength(0);
    });
  });

  describe('stored report version', () => {
    it.each([
      ['has no version', undefined],
      ['predates the current version', ACTIVITY_REPORT_VERSION - 1],
    ])('regenerates a stored past day that %s', async (_label, reportVersion) => {
      mockRefs.storedDaily = [{ date: PAST_DAY, report: 'No activity data found for old', reportVersion }];

      const body = await getDaily(PAST_DAY);

      expect(serviceMocks.generateDailyReport).toHaveBeenCalledTimes(1);
      expect(body.reports[0].report).toBe('formatted daily report');
      expect(databaseMocks.upsertDaily).toHaveBeenCalledWith(PAST_DAY, 'formatted daily report', null);
    });

    it('serves a stored past day at the current version without regenerating', async () => {
      mockRefs.storedDaily = [{ date: PAST_DAY, report: 'stored report', reportVersion: ACTIVITY_REPORT_VERSION }];

      const body = await getDaily(PAST_DAY);

      expect(serviceMocks.generateDailyReport).not.toHaveBeenCalled();
      expect(body.reports[0].report).toBe('stored report');
    });

    it('regenerates a stored week without a version', async () => {
      mockRefs.storedWeekly = { ...PAST_WEEK, report: 'old weekly', aiInsights: null };
      const { req, res } = mocks({ ...PAST_WEEK, weeklyReport: 'true' });

      await mockRefs.getHandler!(req, res);

      expect(serviceMocks.generateDailyReport).toHaveBeenCalledTimes(1);
      expect(res._getJSONData().reports[0].report).toBe('formatted weekly report');
    });

    it('serves a stored week at the current version', async () => {
      mockRefs.storedWeekly = {
        ...PAST_WEEK,
        report: 'stored weekly',
        aiInsights: null,
        reportVersion: ACTIVITY_REPORT_VERSION,
      };
      const { req, res } = mocks({ ...PAST_WEEK, weeklyReport: 'true' });

      await mockRefs.getHandler!(req, res);

      expect(serviceMocks.generateDailyReport).not.toHaveBeenCalled();
      expect(res._getJSONData().reports[0].report).toBe('stored weekly');
    });
  });

  describe('response cache lifetime', () => {
    it('caches a range ending today for 5 minutes', async () => {
      await getDaily(TODAY);

      expect(mockRefs.cacheCalls).toHaveLength(1);
      expect(mockRefs.cacheCalls[0].expiresAt.getTime() - Date.now()).toBe(FIVE_MINUTES_MS);
    });

    it('caches a range of past days for an hour', async () => {
      await getDaily(PAST_DAY);

      expect(mockRefs.cacheCalls[0].expiresAt.getTime() - Date.now()).toBe(ONE_HOUR_MS);
    });
  });
});
