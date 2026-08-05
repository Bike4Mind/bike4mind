import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const { mockFind, mockCount, mockAggregate } = vi.hoisted(() => ({
  mockFind: vi.fn(),
  mockCount: vi.fn(),
  mockAggregate: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const h: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign(
      (req: unknown, res: unknown) => h[(req as { method?: string }).method ?? 'GET']?.(req, res),
      {
        use: () => chain,
        get: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((h.GET = fns[fns.length - 1]), chain),
      }
    );
    return chain;
  },
}));

vi.mock('@server/middlewares/asyncHandler', () => ({
  asyncHandler: (fn: (req: unknown, res: unknown) => unknown) => fn,
}));

vi.mock('@server/utils/errors', () => ({
  ForbiddenError: class ForbiddenError extends Error {},
}));

vi.mock('@server/utils/telemetryProjection', () => ({
  TELEMETRY_SAFE_PROJECTION: 'timestamp promptMeta.contextTelemetry',
}));

vi.mock('@bike4mind/database', () => ({
  Quest: {
    find: (...a: unknown[]) => mockFind(...a),
    countDocuments: (...a: unknown[]) => mockCount(...a),
    aggregate: (...a: unknown[]) => mockAggregate(...a),
  },
}));

import handler from '../context-telemetry';

const SCORE_PATH = 'promptMeta.contextTelemetry.anomalies.anomalyScore';

const run = (query: Record<string, string> = {}, user: unknown = { id: 'admin1', isAdmin: true }) => {
  const { req, res } = createMocks({ method: 'GET', query });
  if (user) (req as Record<string, unknown>).user = user;
  return { res, promise: (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res) };
};

const findQuery = () => mockFind.mock.calls[0][0] as Record<string, unknown>;

const questChain = (entries: unknown[]) => ({
  select: vi.fn().mockReturnThis(),
  sort: vi.fn().mockReturnThis(),
  skip: vi.fn().mockReturnThis(),
  limit: vi.fn().mockReturnThis(),
  lean: vi.fn().mockResolvedValue(entries),
});

beforeEach(() => {
  mockFind.mockReset().mockReturnValue(questChain([]));
  mockCount.mockReset().mockResolvedValue(0);
  mockAggregate.mockReset().mockResolvedValue([]);
});

describe('GET /api/admin/context-telemetry', () => {
  it('rejects non-admin callers', async () => {
    const { promise } = run({}, { id: 'u2', isAdmin: false });
    await expect(promise).rejects.toThrow(/Admin access required/);
  });

  it('defaults to anomalous turns only when no minimum is requested', async () => {
    const { res, promise } = run();
    await promise;
    expect(res._getStatusCode()).toBe(200);
    expect(findQuery()[SCORE_PATH]).toEqual({ $gt: 0 });
  });

  it('widens to benign score-0 turns when minAnomalyScore=0', async () => {
    const { promise } = run({ minAnomalyScore: '0' });
    await promise;
    const query = findQuery();
    // $gte: 0 rather than a dropped predicate, so every path filters on the same
    // anomalyScore key and legacy docs without the anomalies sub-object stay out
    expect(query[SCORE_PATH]).toEqual({ $gte: 0 });
    expect(query['promptMeta.contextTelemetry']).toEqual({ $exists: true });
    // total and stats must reflect the same widened filter as the entry list
    expect(mockCount).toHaveBeenCalledWith(query);
    expect(mockAggregate.mock.calls[0][0][0]).toEqual({ $match: query });
  });

  it('excludes benign turns from the severity distribution', async () => {
    const { promise } = run({ minAnomalyScore: '0' });
    await promise;
    const groupStage = (mockAggregate.mock.calls[0][0] as Record<string, unknown>[])[1] as {
      $group: { severityCounts: { $push: { $cond: unknown[] } } };
    };
    // benign turns are stored as severity 'low', so the distribution must only
    // describe real anomalies — same condition totalAnomalies uses
    expect(groupStage.$group.severityCounts.$push.$cond[0]).toEqual({
      $and: [
        { $ne: ['$promptMeta.contextTelemetry.anomalies.severity', null] },
        { $ne: ['$promptMeta.contextTelemetry.anomalies.primaryAnomaly', 'none'] },
      ],
    });
  });

  it('filters to scores at or above the requested minimum', async () => {
    const { promise } = run({ minAnomalyScore: '30' });
    await promise;
    expect(findQuery()[SCORE_PATH]).toEqual({ $gte: 30 });
  });

  it.each(['abc', '-5', '150', ''])(
    'falls back to the anomalies-only default for invalid minAnomalyScore=%j',
    async raw => {
      const { promise } = run({ minAnomalyScore: raw });
      await promise;
      expect(findQuery()[SCORE_PATH]).toEqual({ $gt: 0 });
    }
  );

  it('excludes benign turns when filtering by severity', async () => {
    const { promise } = run({ minAnomalyScore: '0', severity: 'low' });
    await promise;
    const query = findQuery();
    expect(query['promptMeta.contextTelemetry.anomalies.severity']).toBe('low');
    // benign turns are stored as severity 'low', so "Severity: Low" must not match them
    expect(query['promptMeta.contextTelemetry.anomalies.primaryAnomaly']).toEqual({ $ne: 'none' });
  });

  it('lets an explicit anomaly type win over the severity exclusion', async () => {
    const { promise } = run({ severity: 'high', anomalyType: 'tool_failure' });
    await promise;
    expect(findQuery()['promptMeta.contextTelemetry.anomalies.primaryAnomaly']).toBe('tool_failure');
  });

  it('leaves primaryAnomaly unconstrained when neither severity nor type is filtered', async () => {
    const { promise } = run({ minAnomalyScore: '0' });
    await promise;
    expect(findQuery()['promptMeta.contextTelemetry.anomalies.primaryAnomaly']).toBeUndefined();
  });

  it('returns benign entries with their telemetry when minAnomalyScore=0', async () => {
    const timestamp = new Date('2026-08-04T06:27:22.185Z');
    const telemetry = { captureLevel: 'enhanced', anomalies: { anomalyScore: 0, primaryAnomaly: 'none' } };
    mockFind.mockReturnValue(questChain([{ _id: 'quest-1', timestamp, promptMeta: { contextTelemetry: telemetry } }]));
    mockCount.mockResolvedValue(1);

    const { res, promise } = run({ minAnomalyScore: '0' });
    await promise;

    const body = res._getJSONData();
    expect(body.total).toBe(1);
    expect(body.entries).toEqual([{ id: 'quest-1', timestamp: timestamp.toISOString(), telemetry }]);
  });
});
