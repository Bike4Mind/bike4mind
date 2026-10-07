import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { UserApiKey, ApiKeyUsageLog, userApiKeyRepository } from '@bike4mind/database';
import { ApiKeyStatus } from '@bike4mind/common';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import { runApiKeyBaselineCalculation } from './apiKeyBaselineCalculation';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
let server: Awaited<ReturnType<typeof createMongoServer>>;
const now = new Date('2026-09-30T02:00:00Z');
const start = new Date(now.getTime() - 30 * 86_400_000);
const priorBaseline = { avgRequestsPerDay: 99, commonIPs: [], commonEndpoints: [], peakHours: [] };
async function seedKey(userId: string, status = ApiKeyStatus.ACTIVE) {
  const _id = new mongoose.Types.ObjectId();
  await UserApiKey.collection.insertOne({
    _id,
    userId,
    status,
    keyPrefix: String(_id),
    metadata: { baseline: priorBaseline },
    name: 'local test',
  });
  return String(_id);
}
async function log(
  keyId: string,
  userId: string,
  timestamp: Date,
  responseTime = 100,
  ipAddress = '192.0.2.1',
  endpoint = '/example/a'
) {
  await ApiKeyUsageLog.collection.insertOne({
    keyId,
    userId,
    timestamp,
    responseTime,
    ipAddress,
    endpoint,
    method: 'GET',
    statusCode: 200,
  });
}
async function baseline(id: string) {
  return (await UserApiKey.collection.findOne({ _id: new mongoose.Types.ObjectId(id) }))?.metadata?.baseline;
}
beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});
beforeEach(async () => {
  await UserApiKey.collection.deleteMany({});
  await ApiKeyUsageLog.collection.deleteMany({});
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
describe('API key baseline persisted effects', () => {
  it('uses actual scoped 30-day usage, preserves inactive and empty keys, and repeats stably', async () => {
    const id = await seedKey('owner');
    const inactive = await seedKey('owner', ApiKeyStatus.DISABLED);
    const empty = await seedKey('owner');
    await log(id, 'owner', start);
    await log(id, 'owner', now, 200);
    await log(id, 'owner', new Date('2026-09-10T05:00:00Z'), 300, '192.0.2.2', '/example/b');
    await log(id, 'another-owner', now, 9000);
    await log('another-key', 'owner', now, 9000);
    await log(id, 'owner', new Date(start.getTime() - 1), 9000);
    await log(id, 'owner', new Date(now.getTime() + 1), 9000);
    await log(inactive, 'owner', now, 9000);
    const expected = {
      avgRequestsPerHour: 0,
      avgRequestsPerDay: 0.1,
      avgResponseTime: 200,
      commonIPs: ['192.0.2.1', '192.0.2.2'],
      commonEndpoints: ['/example/a', '/example/b'],
      peakHours: [2, 5],
      lastCalculatedAt: now,
    };
    expect(await runApiKeyBaselineCalculation()).toEqual({
      status: 'success',
      processed: 1,
      skipped: 1,
      errors: 0,
      total: 2,
    });
    expect(await baseline(id)).toEqual(expected);
    expect(await baseline(inactive)).toEqual(priorBaseline);
    expect(await baseline(empty)).toEqual(priorBaseline);
    await runApiKeyBaselineCalculation();
    expect(await baseline(id)).toEqual(expected);
  });
  it('isolates a failed baseline write and repairs it on the next run', async () => {
    const failed = await seedKey('first-owner');
    const good = await seedKey('second-owner');
    for (const [id, userId] of [
      [failed, 'first-owner'],
      [good, 'second-owner'],
    ])
      await log(id!, userId!, now, 200);
    const original = userApiKeyRepository.updateBaseline.bind(userApiKeyRepository);
    const write = vi.spyOn(userApiKeyRepository, 'updateBaseline').mockImplementation(async (id, value) => {
      if (id === failed) throw new Error('injected write failure');
      return original(id, value);
    });
    expect(await runApiKeyBaselineCalculation()).toEqual({
      status: 'success',
      processed: 1,
      skipped: 0,
      errors: 1,
      total: 2,
    });
    expect(await baseline(failed)).toEqual(priorBaseline);
    expect(await baseline(good)).toMatchObject({ avgResponseTime: 200, lastCalculatedAt: now });
    write.mockRestore();
    vi.setSystemTime(new Date(now.getTime() + 86_400_000));
    expect(await runApiKeyBaselineCalculation()).toEqual({
      status: 'success',
      processed: 2,
      skipped: 0,
      errors: 0,
      total: 2,
    });
    expect(await baseline(failed)).toMatchObject({
      avgResponseTime: 200,
      lastCalculatedAt: new Date(now.getTime() + 86_400_000),
    });
  });
});
