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

const base = {
  userId: 'user-1',
  name: 'key',
  keyHash: '$2b$12$abcdefghijklmnopqrstuv',
  scopes: [ApiKeyScope.AI_CHAT],
  metadata: { createdFrom: 'dashboard' as const },
};

const DIGEST = 'a'.repeat(64);

describe('UserApiKeyModel keyDigest', () => {
  it('setKeyDigest persists the digest so the prefix lookup returns it', async () => {
    const created = await UserApiKey.create({ ...base, keyPrefix: 'b4m_live_digest01' });
    expect(created.keyDigest).toBeUndefined();

    await userApiKeyRepository.setKeyDigest(created.id, DIGEST);

    const found = await userApiKeyRepository.findActiveByKeyPrefix('b4m_live_digest01');
    expect(found?.keyDigest).toBe(DIGEST);
  });

  it('strips keyDigest (and keyHash) from toJSON, the serializer every API response uses', async () => {
    await UserApiKey.create({ ...base, keyPrefix: 'b4m_live_digest02', keyDigest: DIGEST });

    const [listed] = await userApiKeyRepository.findByUserId('user-1');
    const json = listed.toJSON() as Record<string, unknown>;
    expect('keyDigest' in json).toBe(false);
    expect('keyHash' in json).toBe(false);
    expect(JSON.stringify(listed)).not.toContain(DIGEST);
  });
});
