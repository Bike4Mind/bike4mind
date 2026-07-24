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
