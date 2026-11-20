import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { ApiKeyStatus, type IUserApiKeyModerationException } from '@bike4mind/common';
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

// keyPrefix has a unique index, so every seeded key needs its own.
let seeded = 0;

const seedKey = async () => {
  seeded += 1;
  const doc = await UserApiKey.collection.insertOne({
    userId: 'owner-1',
    name: 'k',
    keyPrefix: `b4m_live_modex_${seeded}`,
    status: ApiKeyStatus.ACTIVE,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return doc.insertedId.toString();
};

const exception = (categories: string[]) =>
  ({
    categories,
    reason: 'Approved integration key',
    setBy: 'admin-1',
    setAt: new Date('2026-01-01T00:00:00.000Z'),
  }) as IUserApiKeyModerationException;

describe('UserApiKey moderation exception', () => {
  it('has none by default', async () => {
    const id = await seedKey();
    await expect(userApiKeyRepository.findModerationException(id)).resolves.toBeNull();
    await expect(userApiKeyRepository.findModerationException(new mongoose.Types.ObjectId().toString())).resolves.toBe(
      null
    );
  });

  it('stores the exception and returns it with the fields that decide whether it applies', async () => {
    const id = await seedKey();
    await userApiKeyRepository.setModerationException(id, exception(['violence', 'violence/graphic']));

    await expect(userApiKeyRepository.findModerationException(id)).resolves.toMatchObject({
      userId: 'owner-1',
      status: ApiKeyStatus.ACTIVE,
      moderationException: {
        categories: ['violence', 'violence/graphic'],
        reason: 'Approved integration key',
        setBy: 'admin-1',
      },
    });
  });

  it('keeps the exception out of ordinary reads and JSON', async () => {
    const id = await seedKey();
    await userApiKeyRepository.setModerationException(id, exception(['violence']));

    const key = await userApiKeyRepository.findById(id);
    expect(key?.moderationException).toBeUndefined();
    expect(JSON.stringify(key)).not.toContain('Approved integration key');
  });

  it.each([
    ['a category off the shared list', ['violence', 'hate']],
    ['an empty list', []],
  ])('refuses %s', async (_label, categories) => {
    const id = await seedKey();
    await expect(userApiKeyRepository.setModerationException(id, exception(categories))).rejects.toThrow();
    await expect(userApiKeyRepository.findModerationException(id)).resolves.toBeNull();
  });

  it('clears the exception', async () => {
    const id = await seedKey();
    await userApiKeyRepository.setModerationException(id, exception(['violence']));
    await userApiKeyRepository.setModerationException(id, null);
    await expect(userApiKeyRepository.findModerationException(id)).resolves.toBeNull();
  });
});
