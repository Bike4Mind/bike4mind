import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { connectTestDB, disconnectTestDB } from './utils';
import { ApiKeyUsageLog, apiKeyUsageLogRepository } from '../models/auth/ApiKeyUsageLogModel';

// #773: the API-key usage view now derives request counts from the usage log via
// countRequestsByKeyForUser (the UserApiKey.usage counters are never written).
describe('ApiKeyUsageLogRepository.countRequestsByKeyForUser', () => {
  let mongoServer: MongoMemoryServer;

  beforeAll(async () => {
    mongoServer = await connectTestDB();
  }, 30000);

  afterAll(async () => {
    await disconnectTestDB(mongoServer);
  }, 30000);

  beforeEach(async () => {
    await ApiKeyUsageLog.deleteMany({});
  });

  const base = {
    ipAddress: '203.0.113.1',
    endpoint: '/api/ai/v1/completions',
    method: 'POST',
    responseTime: 12,
    statusCode: 200,
  };
  const logRequest = (userId: string, keyId: string, timestamp: Date) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test seed: partial log doc
    apiKeyUsageLogRepository.create({ userId, keyId, timestamp, ...base } as any);

  it('returns per-key lifetime total and today count matching the logged requests', async () => {
    const dayStart = new Date();
    dayStart.setUTCHours(0, 0, 0, 0);
    const earlierToday = new Date(dayStart.getTime() + 60 * 60 * 1000); // +1h (today)
    const beforeToday = new Date(dayStart.getTime() - 2 * 60 * 60 * 1000); // -2h (before today, still <90d)

    // keyA: 2 today + 1 before today -> total 3, today 2
    await logRequest('user-1', 'keyA', earlierToday);
    await logRequest('user-1', 'keyA', earlierToday);
    await logRequest('user-1', 'keyA', beforeToday);
    // keyB: 1 today -> total 1, today 1
    await logRequest('user-1', 'keyB', earlierToday);
    // another user's key must NOT leak into user-1's counts
    await logRequest('user-2', 'keyC', earlierToday);

    const counts = await apiKeyUsageLogRepository.countRequestsByKeyForUser('user-1', dayStart);

    expect(counts.keyA).toEqual({ totalRequests: 3, requestsToday: 2 });
    expect(counts.keyB).toEqual({ totalRequests: 1, requestsToday: 1 });
    expect(counts.keyC).toBeUndefined(); // user-scoped
  });

  it('returns an empty map when the user has no logged requests', async () => {
    const dayStart = new Date();
    dayStart.setUTCHours(0, 0, 0, 0);
    const counts = await apiKeyUsageLogRepository.countRequestsByKeyForUser('nobody', dayStart);
    expect(counts).toEqual({});
  });
});

describe('ApiKeyUsageLogRepository.platformEndpointUsage', () => {
  let mongoServer: MongoMemoryServer;

  beforeAll(async () => {
    mongoServer = await connectTestDB();
  }, 30000);

  afterAll(async () => {
    await disconnectTestDB(mongoServer);
  }, 30000);

  beforeEach(async () => {
    await ApiKeyUsageLog.deleteMany({});
  });

  const log = (overrides: Partial<Record<string, unknown>> = {}) =>
    apiKeyUsageLogRepository.create({
      userId: 'user-1',
      keyId: 'keyA',
      ipAddress: '203.0.113.1',
      endpoint: '/api/ai/v1/completions',
      method: 'POST',
      responseTime: 10,
      statusCode: 200,
      timestamp: new Date(),
      ...overrides,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test seed: partial log doc
    } as any);

  it('groups by endpoint+method with request count, avg + p95 latency, and error rate', async () => {
    // /a POST: 5 ok requests, latencies 10..50 -> avg 30, p95 (nearest-rank) 50.
    for (const rt of [10, 20, 30, 40, 50]) {
      await log({ endpoint: '/a', method: 'POST', responseTime: rt, statusCode: 200 });
    }
    // /b GET: 2 requests, one server error -> errorRate 0.5.
    await log({ endpoint: '/b', method: 'GET', responseTime: 5, statusCode: 200 });
    await log({ endpoint: '/b', method: 'GET', responseTime: 7, statusCode: 500 });

    const { byEndpoint } = await apiKeyUsageLogRepository.platformEndpointUsage({ days: 30 });

    // Ordered by request count desc.
    expect(byEndpoint).toMatchObject([
      { endpoint: '/a', method: 'POST', requests: 5, errorRate: 0 },
      { endpoint: '/b', method: 'GET', requests: 2 },
    ]);
    expect(byEndpoint[0].avgResponseTimeMs).toBeCloseTo(30, 10);
    expect(byEndpoint[0].p95ResponseTimeMs).toBe(50);
    expect(byEndpoint[1].errorRate).toBeCloseTo(0.5, 10);
  });

  it('rolls up over-time request counts by UTC day', async () => {
    await log({ responseTime: 10 });
    await log({ responseTime: 20 });

    const { overTime } = await apiKeyUsageLogRepository.platformEndpointUsage({ days: 30 });
    expect(overTime).toHaveLength(1);
    expect(overTime[0]).toMatchObject({ requests: 2 });
    expect(overTime[0].day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('excludes requests outside the trailing window', async () => {
    await log({ timestamp: new Date('2020-01-01') });
    const result = await apiKeyUsageLogRepository.platformEndpointUsage({ days: 30 });
    expect(result.byEndpoint).toHaveLength(0);
    expect(result.overTime).toHaveLength(0);
  });

  it('supports an hours window', async () => {
    await log({ timestamp: new Date(Date.now() - 2 * 60 * 60 * 1000) }); // 2h ago
    const oneHour = await apiKeyUsageLogRepository.platformEndpointUsage({ hours: 1 });
    expect(oneHour.byEndpoint).toHaveLength(0);
    const threeHours = await apiKeyUsageLogRepository.platformEndpointUsage({ hours: 3 });
    expect(threeHours.byEndpoint).toHaveLength(1);
  });
});
