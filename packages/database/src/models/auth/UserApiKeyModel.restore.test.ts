import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { ApiKeyStatus } from '@bike4mind/common';
import { createMongoServer } from '../../__test__/createMongoServer';
import { UserApiKey, userApiKeyRepository } from './UserApiKeyModel';

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
  await UserApiKey.deleteMany({});
});

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);

// keyPrefix has a unique index, so every seeded key needs its own.
let seeded = 0;

const seedRevoked = async (overrides: Record<string, unknown> = {}) => {
  seeded += 1;
  const doc = await UserApiKey.collection.insertOne({
    userId: 'owner-1',
    name: 'k',
    keyPrefix: `b4m_live_${seeded}`,
    status: ApiKeyStatus.DISABLED,
    revokedAt: minutesAgo(1),
    revokedBy: 'admin-1',
    revokedReason: 'leaked',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });
  return doc.insertedId.toString();
};

describe('UserApiKeyRepository.revokeIfNotDisabled', () => {
  it('reports whether this call revoked the key and keeps the first stamp', async () => {
    const id = await seedRevoked({ status: ApiKeyStatus.ACTIVE, revokedBy: null });
    expect(await userApiKeyRepository.revokeIfNotDisabled(id, 'admin-1', 'leaked')).toBe(true);
    expect(await userApiKeyRepository.revokeIfNotDisabled(id, 'admin-2', 'again')).toBe(false);

    const raw = await UserApiKey.collection.findOne({ _id: new mongoose.Types.ObjectId(id) });
    expect(raw?.revokedBy).toBe('admin-1');
  });
});

describe('UserApiKeyRepository.restoreRevoked', () => {
  it('reactivates the key and clears the revoke stamps', async () => {
    const id = await seedRevoked();

    expect(await userApiKeyRepository.restoreRevoked(id, 'admin-1', minutesAgo(5))).toBe(true);

    const raw = await UserApiKey.collection.findOne({ _id: new mongoose.Types.ObjectId(id) });
    expect(raw?.status).toBe(ApiKeyStatus.ACTIVE);
    expect(raw).not.toHaveProperty('revokedAt');
    expect(raw).not.toHaveProperty('revokedBy');
    expect(raw).not.toHaveProperty('revokedReason');
  });

  it('refuses a second restore of the same revoke', async () => {
    const id = await seedRevoked();
    expect(await userApiKeyRepository.restoreRevoked(id, 'admin-1', minutesAgo(5))).toBe(true);
    expect(await userApiKeyRepository.restoreRevoked(id, 'admin-1', minutesAgo(5))).toBe(false);
  });

  it('refuses another actor, a revoke older than the window and an expired key', async () => {
    const byOther = await seedRevoked({ revokedBy: 'admin-2' });
    const stale = await seedRevoked({ revokedAt: minutesAgo(30) });
    const expired = await seedRevoked({ expiresAt: minutesAgo(10) });

    expect(await userApiKeyRepository.restoreRevoked(byOther, 'admin-1', minutesAgo(5))).toBe(false);
    expect(await userApiKeyRepository.restoreRevoked(stale, 'admin-1', minutesAgo(5))).toBe(false);
    expect(await userApiKeyRepository.restoreRevoked(expired, 'admin-1', minutesAgo(5))).toBe(false);
  });

  it('refuses a key that is not disabled', async () => {
    const id = await seedRevoked({ status: ApiKeyStatus.ACTIVE });
    expect(await userApiKeyRepository.restoreRevoked(id, 'admin-1', minutesAgo(5))).toBe(false);
  });
});
