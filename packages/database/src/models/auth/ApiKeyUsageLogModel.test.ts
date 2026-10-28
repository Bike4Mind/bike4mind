import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoServer } from '../../__test__/createMongoServer';
import { ApiKeyUsageLog, apiKeyUsageLogRepository } from './ApiKeyUsageLogModel';

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await createMongoServer();
  await mongoose.connect(mongod.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

afterEach(async () => {
  await ApiKeyUsageLog.deleteMany({});
});

const now = new Date(Date.UTC(2026, 5, 15, 12));
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3600_000);

const log = (userId: string, keyId: string, timestamp: Date) => ({
  userId,
  keyId,
  timestamp,
  ipAddress: '127.0.0.1',
  endpoint: '/api/chat',
  method: 'POST',
  responseTime: 5,
  statusCode: 200,
});

describe('ApiKeyUsageLogRepository.countRequestsByKeyWindows', () => {
  it('counts the 24h and 7d windows per key for one user', async () => {
    await ApiKeyUsageLog.collection.insertMany([
      log('u1', 'k1', hoursAgo(1)),
      log('u1', 'k1', hoursAgo(30)),
      log('u1', 'k1', hoursAgo(24 * 6)),
      log('u1', 'k1', hoursAgo(24 * 8)),
      log('u1', 'k2', hoursAgo(2)),
      log('u2', 'k3', hoursAgo(2)),
    ]);

    const counts = await apiKeyUsageLogRepository.countRequestsByKeyWindows('u1', now);

    expect(counts).toEqual({ k1: { last24h: 1, last7d: 3 }, k2: { last24h: 1, last7d: 1 } });
  });

  it('returns an empty record when the user made no requests', async () => {
    expect(await apiKeyUsageLogRepository.countRequestsByKeyWindows('nobody', now)).toEqual({});
  });
});
