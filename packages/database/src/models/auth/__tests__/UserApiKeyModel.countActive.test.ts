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

describe('UserApiKeyRepository.countActiveByUserId - cap pools', () => {
  const userId = 'pool-user';
  const future = () => new Date(Date.now() + 60 * 60 * 1000);
  const exchange = (oauthClientId: string) => ({
    userId,
    expiresAt: future(),
    metadata: { createdFrom: 'oauth-exchange' as const, oauthClientId },
  });

  it('keeps live exchange keys out of the standard pool and counts them in their own', async () => {
    for (let i = 0; i < 2; i++) await createKey({ userId, expiresAt: future() });
    for (const clientId of ['client-a', 'client-b', 'client-c']) await createKey(exchange(clientId));

    await expect(userApiKeyRepository.countActiveByUserId(userId)).resolves.toBe(2);
    await expect(userApiKeyRepository.countActiveByUserId(userId, 'standard')).resolves.toBe(2);
    await expect(userApiKeyRepository.countActiveByUserId(userId, 'oauth-exchange')).resolves.toBe(3);
  });

  it('applies the same expiry and status predicate to the exchange pool', async () => {
    await createKey(exchange('client-a'));
    await createKey({ ...exchange('client-b'), expiresAt: new Date(Date.now() - 1000) });
    await createKey({ ...exchange('client-c'), status: ApiKeyStatus.DISABLED });

    await expect(userApiKeyRepository.countActiveByUserId(userId, 'oauth-exchange')).resolves.toBe(1);
  });

  it('counts a legacy row with no metadata in the standard pool', async () => {
    // Bypass schema validation (metadata.createdFrom is required) to reproduce a pre-schema row.
    await UserApiKey.collection.insertOne({
      userId,
      name: 'legacy',
      keyHash: 'x',
      keyPrefix: 'b4m_live_legacy01',
      scopes: [ApiKeyScope.AI_GENERATE],
      status: ApiKeyStatus.ACTIVE,
      deletedAt: null,
    });

    await expect(userApiKeyRepository.countActiveByUserId(userId, 'standard')).resolves.toBe(1);
    await expect(userApiKeyRepository.countActiveByUserId(userId, 'oauth-exchange')).resolves.toBe(0);
  });
});

describe('UserApiKeyRepository.createIfUnderCap', () => {
  const userId = 'cap-create-user';
  const future = () => new Date(Date.now() + 60 * 60 * 1000);

  it('returns the document when count is under cap', async () => {
    const result = await userApiKeyRepository.createIfUnderCap(
      {
        userId,
        name: 'k',
        keyHash: 'h',
        keyPrefix: 'b4m_live_cicu0001',
        scopes: [ApiKeyScope.AI_GENERATE],
        metadata: { createdFrom: 'dashboard' as const },
      },
      10,
      'standard'
    );
    expect(result).not.toBe('at_cap');
    expect((result as { userId: string }).userId).toBe(userId);
  });

  it('returns at_cap and revokes the key when inserting would exceed the cap', async () => {
    // Fill up to the cap first.
    for (let i = 0; i < 3; i++) {
      await createKey({ userId, expiresAt: future() });
    }
    const result = await userApiKeyRepository.createIfUnderCap(
      {
        userId,
        name: 'over',
        keyHash: 'h',
        keyPrefix: 'b4m_live_cicu0010',
        scopes: [ApiKeyScope.AI_GENERATE],
        metadata: { createdFrom: 'dashboard' as const },
      },
      3,
      'standard'
    );
    expect(result).toBe('at_cap');
    // The key was inserted then revoked; active count must remain at the cap.
    await expect(userApiKeyRepository.countActiveByUserId(userId, 'standard')).resolves.toBe(3);
  });

  it('keeps exactly cap keys when two concurrent inserts race at cap - 1', async () => {
    const cap = 3;
    // Seed cap - 1 active keys so both concurrent calls see room and both insert.
    for (let i = 0; i < cap - 1; i++) {
      await createKey({ userId, expiresAt: future() });
    }
    const docA = {
      userId,
      name: 'a',
      keyHash: 'ha',
      keyPrefix: 'b4m_live_cicuA001',
      scopes: [ApiKeyScope.AI_GENERATE],
      metadata: { createdFrom: 'dashboard' as const },
    };
    const docB = {
      userId,
      name: 'b',
      keyHash: 'hb',
      keyPrefix: 'b4m_live_cicuB001',
      scopes: [ApiKeyScope.AI_GENERATE],
      metadata: { createdFrom: 'dashboard' as const },
    };
    // Fire both concurrently without awaiting between them.
    const [resultA, resultB] = await Promise.all([
      userApiKeyRepository.createIfUnderCap(docA, cap, 'standard'),
      userApiKeyRepository.createIfUnderCap(docB, cap, 'standard'),
    ]);
    // Exactly one must succeed and one must be at_cap, landing at exactly cap active keys.
    const atCapCount = [resultA, resultB].filter(r => r === 'at_cap').length;
    expect(atCapCount).toBe(1);
    await expect(userApiKeyRepository.countActiveByUserId(userId, 'standard')).resolves.toBe(cap);
  });

  it('isolates standard and oauth-exchange pools', async () => {
    const cap = 2;
    // Fill the standard pool to the cap.
    for (let i = 0; i < cap; i++) {
      await createKey({ userId, expiresAt: future() });
    }
    // An exchange-pool insert should still succeed.
    const result = await userApiKeyRepository.createIfUnderCap(
      {
        userId,
        name: 'ex',
        keyHash: 'hex',
        keyPrefix: 'b4m_live_cicuEX01',
        scopes: [ApiKeyScope.AI_GENERATE],
        expiresAt: future(),
        metadata: { createdFrom: 'oauth-exchange' as const, oauthClientId: 'client-x' },
      },
      cap,
      'oauth-exchange'
    );
    expect(result).not.toBe('at_cap');
    await expect(userApiKeyRepository.countActiveByUserId(userId, 'standard')).resolves.toBe(cap);
    await expect(userApiKeyRepository.countActiveByUserId(userId, 'oauth-exchange')).resolves.toBe(1);
  });
});
