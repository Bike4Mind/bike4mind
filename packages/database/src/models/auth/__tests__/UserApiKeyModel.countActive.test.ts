import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoServer } from '../../../__test__/createMongoServer';
import { UserApiKey, userApiKeyRepository } from '../UserApiKeyModel';
import { ApiKeyScope, ApiKeyStatus } from '@bike4mind/common';

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
  vi.useRealTimers();
  // Raw-driver hard delete on purpose. The model's deleteMany is the soft-delete
  // plugin (sets deletedAt), and countDocuments does not apply the plugin's
  // `deletedAt: null` pre-hook - leaving rows behind would inflate later counts.
  await UserApiKey.collection.deleteMany({});
});

let keySeq = 0;

async function createKey(overrides: Record<string, unknown> = {}) {
  // keyPrefix carries a unique index, so each key needs its own prefix.
  keySeq += 1;
  return UserApiKey.create({
    name: 'k',
    keyHash: '$2b$12$abcdefghijklmnopqrstuv',
    keyPrefix: `b4m_live_cap${String(keySeq).padStart(4, '0')}`,
    scopes: [ApiKeyScope.AI_GENERATE],
    metadata: { createdFrom: 'dashboard' as const },
    ...overrides,
  });
}

describe('UserApiKeyRepository.countActiveByUserId', () => {
  const userId = 'cap-user';
  const otherUserId = 'cap-other-user';

  it('counts only ACTIVE, unexpired keys for the user', async () => {
    const future = new Date(Date.now() + 60 * 60 * 1000);
    const past = new Date(Date.now() - 60 * 60 * 1000);

    for (let i = 0; i < 3; i++) await createKey({ userId, expiresAt: future });
    for (let i = 0; i < 2; i++) await createKey({ userId }); // no expiry at all
    for (let i = 0; i < 4; i++) await createKey({ userId, expiresAt: past }); // expired
    await createKey({ userId, status: ApiKeyStatus.DISABLED, expiresAt: future });
    await createKey({ userId: otherUserId, expiresAt: future });

    // 3 future + 2 never-expiring; the 4 expired ACTIVE keys must not count.
    await expect(userApiKeyRepository.countActiveByUserId(userId)).resolves.toBe(5);
  });

  it.each([
    ['one millisecond before expiry', -1, 1],
    ['exactly at expiry', 0, 0],
    ['one millisecond after expiry', 1, 0],
  ])('counts correctly %s', async (_label, offset, expectedCount) => {
    const expiresAt = new Date('2026-01-01T00:00:00.000Z');
    await createKey({ userId, expiresAt });
    // Keep MongoDB's I/O timers real; only the repository's clock is pinned.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(expiresAt.getTime() + offset));
    await expect(userApiKeyRepository.countActiveByUserId(userId)).resolves.toBe(expectedCount);
  });

  it('counts an explicitly null expiry as never expiring', async () => {
    await createKey({ userId, expiresAt: null });
    await expect(userApiKeyRepository.countActiveByUserId(userId)).resolves.toBe(1);
  });

  it('returns 0 for a user with no keys', async () => {
    await expect(userApiKeyRepository.countActiveByUserId('nobody')).resolves.toBe(0);
  });
});
