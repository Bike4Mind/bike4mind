import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoServer } from '../../../__test__/createMongoServer';
import { UserApiKey } from '../UserApiKeyModel';
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
  keyDigest: 'a'.repeat(64),
  metadata: { createdFrom: 'dashboard' as const },
};

describe('UserApiKeyModel scopes', () => {
  it('stores a contributed scope and re-saves the key without the contributed catalog loaded', async () => {
    const created = await UserApiKey.create({
      ...base,
      keyPrefix: 'b4m_live_scopes01',
      scopes: ['acme:read', ApiKeyScope.READ_NOTEBOOKS],
    });

    const found = await UserApiKey.findById(created.id);
    expect(found?.scopes).toEqual(['acme:read', ApiKeyScope.READ_NOTEBOOKS]);

    found!.name = 'renamed';
    await expect(found!.save()).resolves.toBeDefined();
    expect((await UserApiKey.findById(created.id))?.scopes).toEqual(['acme:read', ApiKeyScope.READ_NOTEBOOKS]);
  });

  it.each([['Acme:read'], ['acme'], ['']])('rejects the malformed scope %j', async scope => {
    await expect(UserApiKey.create({ ...base, keyPrefix: 'b4m_live_scopes02', scopes: [scope] })).rejects.toThrow(
      /scope|scopes/i
    );
  });
});
