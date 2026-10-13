import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { ApiKeyScope } from '@bike4mind/common';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import { userApiKeyRepository } from '@bike4mind/database';
import { userApiKeyService } from '@bike4mind/services';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

// Consumes the built dist, so `pnpm turbo:core:build` must be current.
let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});
afterEach(async () => {
  await mongoose.connection.dropDatabase();
});

describe('createExchangeUserApiKey against the real repository', () => {
  it('mints with the route TTL into the exchange pool and not the standard pool', async () => {
    const minted = await userApiKeyService.createExchangeUserApiKey(
      'owner-1',
      {
        name: 'AI (federated: test)',
        scopes: [ApiKeyScope.AI_GENERATE],
        expiresAt: new Date(Date.now() + userApiKeyService.MAX_EXCHANGE_KEY_TTL_MS),
        metadata: { oauthClientId: 'client-a' },
      },
      { db: { userApiKeys: userApiKeyRepository, agents: { findById: async () => null } } }
    );

    expect(minted.metadata.createdFrom).toBe('oauth-exchange');
    expect(await userApiKeyRepository.countActiveByUserId('owner-1', 'oauth-exchange')).toBe(1);
    expect(await userApiKeyRepository.countActiveByUserId('owner-1', 'standard')).toBe(0);
  });
});
