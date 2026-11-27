import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
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
  // Raw-driver hard delete: the model's deleteMany is the soft-delete plugin.
  await UserApiKey.collection.deleteMany({});
});

let keySeq = 0;

async function createKey(userId: string, createdAt: Date, overrides: Record<string, unknown> = {}) {
  keySeq += 1;
  const key = await UserApiKey.create({
    userId,
    name: 'k',
    keyHash: '$2b$12$abcdefghijklmnopqrstuv',
    keyPrefix: `b4m_live_first${String(keySeq).padStart(4, '0')}`,
    scopes: [ApiKeyScope.AI_GENERATE],
    metadata: { createdFrom: 'dashboard' as const },
    ...overrides,
  });
  // Raw driver write: mongoose timestamps make createdAt immutable through the model.
  await UserApiKey.collection.updateOne({ _id: key._id }, { $set: { createdAt } });
  return key;
}

describe('UserApiKeyRepository.findFirstCreatedAtByUserId', () => {
  it('returns null for a user with no keys', async () => {
    await expect(userApiKeyRepository.findFirstCreatedAtByUserId('nobody')).resolves.toBeNull();
  });

  it("returns the user's earliest key, not another user's", async () => {
    await createKey('other', new Date('2026-10-01T00:00:00Z'));
    await createKey('u1', new Date('2026-10-21T00:00:00Z'));
    await createKey('u1', new Date('2026-10-20T00:00:00Z'));

    await expect(userApiKeyRepository.findFirstCreatedAtByUserId('u1')).resolves.toEqual(
      new Date('2026-10-20T00:00:00Z')
    );
  });

  it('counts a key that was later disabled or deleted', async () => {
    await createKey('u1', new Date('2026-10-20T00:00:00Z'), { status: ApiKeyStatus.DISABLED });
    const deleted = await createKey('u1', new Date('2026-10-19T00:00:00Z'));
    await UserApiKey.collection.updateOne({ _id: deleted._id }, { $set: { deletedAt: new Date() } });
    await createKey('u1', new Date('2026-10-22T00:00:00Z'));

    await expect(userApiKeyRepository.findFirstCreatedAtByUserId('u1')).resolves.toEqual(
      new Date('2026-10-19T00:00:00Z')
    );
  });
});

describe('UserApiKeyRepository.countCreatedByUserIds', () => {
  it('counts every key each user created, disabled and deleted included', async () => {
    await createKey('u1', new Date('2026-10-20T00:00:00Z'));
    await createKey('u1', new Date('2026-10-21T00:00:00Z'), { status: ApiKeyStatus.DISABLED });
    const deleted = await createKey('u2', new Date('2026-10-21T00:00:00Z'));
    await UserApiKey.collection.updateOne({ _id: deleted._id }, { $set: { deletedAt: new Date() } });
    await createKey('other', new Date('2026-10-21T00:00:00Z'));

    await expect(userApiKeyRepository.countCreatedByUserIds(['u1', 'u2', 'none'])).resolves.toEqual({ u1: 2, u2: 1 });
  });

  it('returns nothing for no users', async () => {
    await expect(userApiKeyRepository.countCreatedByUserIds([])).resolves.toEqual({});
  });
});
