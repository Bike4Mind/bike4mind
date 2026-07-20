import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoServer } from '../../../__test__/createMongoServer';
import { UserApiKey, userApiKeyRepository } from '../UserApiKeyModel';
import { ApiKeyScope } from '@bike4mind/common';

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await createMongoServer();
  await mongoose.connect(mongod.getUri());
  await UserApiKey.syncIndexes();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

afterEach(async () => {
  await UserApiKey.deleteMany({});
});

let keySeq = 0;

async function createKey() {
  // Unique prefix per key: keyPrefix carries a unique index and the soft-delete
  // plugin keeps removed docs around, so a shared prefix collides across tests.
  keySeq += 1;
  return UserApiKey.create({
    userId: 'u1',
    name: 'k',
    keyHash: '$2b$12$abcdefghijklmnopqrstuv',
    keyPrefix: `b4m_live_spend${String(keySeq).padStart(3, '0')}`,
    scopes: [ApiKeyScope.EMBED_CHAT],
    metadata: { createdFrom: 'dashboard' as const },
    agentId: 'agent-1',
  });
}

describe('UserApiKeyRepository.incrementSpend', () => {
  it('a fresh key reads usage.totalSpendCredits === 0', async () => {
    const created = await createKey();
    const loaded = await UserApiKey.findById(created.id);
    expect(loaded?.usage.totalSpendCredits).toBe(0);
  });

  it('accumulates exactly under concurrent increments (atomic $inc, no lost updates)', async () => {
    const created = await createKey();

    await Promise.all(Array.from({ length: 25 }, () => userApiKeyRepository.incrementSpend(created.id, 7)));

    const loaded = await UserApiKey.findById(created.id);
    expect(loaded?.usage.totalSpendCredits).toBe(25 * 7);
  });

  it.each([
    ['zero', 0],
    ['negative', -5],
    ['NaN', NaN],
    ['Infinity', Infinity],
  ])('is a no-op for a %s amount', async (_label, credits) => {
    const created = await createKey();
    await userApiKeyRepository.incrementSpend(created.id, 100);

    await userApiKeyRepository.incrementSpend(created.id, credits);

    const loaded = await UserApiKey.findById(created.id);
    expect(loaded?.usage.totalSpendCredits).toBe(100);
  });

  it('updateUsage does not clobber totalSpendCredits (per-path $set invariant)', async () => {
    const created = await createKey();
    await userApiKeyRepository.incrementSpend(created.id, 42);

    await userApiKeyRepository.updateUsage(created.id, {
      totalRequests: 5,
      totalTokens: 500,
      requestsToday: 5,
      requestsThisMinute: 1,
    });

    const loaded = await UserApiKey.findById(created.id);
    expect(loaded?.usage.totalSpendCredits).toBe(42);
    expect(loaded?.usage.totalRequests).toBe(5);
  });
});
