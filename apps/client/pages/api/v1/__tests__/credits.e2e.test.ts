// @vitest-environment node
/**
 * Satellite apps read the balance with the key pages/api/oauth/ai-token.ts mints. Pins that a key
 * minted the same way (createdFrom 'oauth-exchange', me:read or ai:generate only) is accepted by
 * GET /api/v1/credits through its real nextRouteForContract chain (API-key validation, policy
 * consent gate, scope gate), against real Mongo.
 */
import { afterAll, beforeAll, afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import mongoose from 'mongoose';
import { createMocks } from 'node-mocks-http';
import type { MongoMemoryServer } from 'mongodb-memory-server';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import {
  createMongoServer,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../../packages/database/src/__test__/createMongoServer';

vi.mock('@server/utils/apiKeyRateLimitCheck', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  checkApiKeyRateLimit: vi.fn().mockResolvedValue({ allowed: true, retryAfter: undefined, headers: {} }),
}));
vi.mock('@server/middlewares/rateLimit', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('@server/utils/analyticsLog', () => ({
  logEvent: vi.fn().mockResolvedValue(undefined),
  logEventSafe: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@bike4mind/database', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  connectDB: vi.fn().mockResolvedValue(undefined),
}));

import { ApiKeyScope } from '@bike4mind/common';
import { User, agentRepository, userApiKeyRepository } from '@bike4mind/database';
import { userApiKeyService } from '@bike4mind/services';
import handler from '../credits';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

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

// Same shape as the ai-token exchange mint.
async function mintExchangeKey(scopes: ApiKeyScope[]) {
  const user = await User.create({
    username: 'satellite-user',
    name: 'Satellite User',
    email: 'satellite@example.com',
    currentCredits: 1234,
    // ai-token refuses to mint for a user who has not accepted the policies.
    aupAcceptedVersion: '2026-01-01',
  });
  const minted = await userApiKeyService.createExchangeUserApiKey(
    user.id,
    {
      name: 'AI (federated: Satellite)',
      scopes,
      expiresAt: new Date(Date.now() + userApiKeyService.MAX_EXCHANGE_KEY_TTL_MS),
      metadata: {
        clientIP: '127.0.0.1',
        userAgent: 'vitest',
        oauthClientId: 'b4m_sat_0123abcd',
      },
    },
    { db: { userApiKeys: userApiKeyRepository, agents: agentRepository } }
  );
  return minted.key;
}

async function getCredits(apiKey: string) {
  const { req, res } = createMocks(
    { method: 'GET', url: '/api/v1/credits', headers: { 'x-api-key': apiKey } } as never,
    { eventEmitter: EventEmitter }
  );
  await handler(req as never, res as never);
  return res;
}

describe('GET /api/v1/credits with an exchange-minted key', () => {
  it.each([[ApiKeyScope.ME_READ], [ApiKeyScope.AI_GENERATE]])('a %s key reads its own balance', async scope => {
    const res = await getCredits(await mintExchangeKey([scope]));
    expect({ status: res._getStatusCode(), body: res._getJSONData() }).toEqual({
      status: 200,
      body: { balance: 1234 },
    });
  });

  it('a key with only an unrelated scope is refused', async () => {
    const res = await getCredits(await mintExchangeKey([ApiKeyScope.READ_PROJECTS]));
    expect(res._getStatusCode()).toBe(403);
    expect(res._getJSONData().required_scopes).toEqual(
      expect.arrayContaining([ApiKeyScope.ME_READ, ApiKeyScope.AI_GENERATE])
    );
  });
});
