import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { Cache } from '@bike4mind/database';
import { UserApiKey } from '@bike4mind/database/auth';
import { createMongoServer } from '../../../database/src/__test__/createMongoServer';
import { checkApiKeyRateLimit, getApiKeyRateLimitUsage, resetApiKeyRateLimit } from './apiKeyRateLimitCheck';

let server: Awaited<ReturnType<typeof createMongoServer>>;
beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
  await Promise.all([Cache.init(), UserApiKey.init()]);
}, 60_000);
afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});
afterEach(async () => {
  await Promise.all([Cache.deleteMany({}), UserApiKey.deleteMany({})]);
});

const mint = (userId: string, oauthClientId: string, createdFrom = 'oauth-exchange') =>
  UserApiKey.create({
    userId,
    name: 'Quota test',
    keyPrefix: new mongoose.Types.ObjectId().toString(),
    scopes: ['ai:generate'],
    metadata: { createdFrom, oauthClientId },
  });

describe('federated quotas with real Mongo counters', () => {
  it('shares concurrent daily usage across replacements, with usage and reset parity', async () => {
    const old = await mint('user-a', 'client-a');
    const replacement = await mint('user-a', 'client-a');
    const limits = { requestsPerMinute: 100, requestsPerDay: 3 };
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) => checkApiKeyRateLimit(index % 2 ? old.id : replacement.id, limits))
    );
    expect(results.filter(result => result.allowed)).toHaveLength(3);
    expect(results.filter(result => !result.allowed)).toHaveLength(5);
    expect(await getApiKeyRateLimitUsage(replacement.id)).toMatchObject({ minute: 3, day: 3 });
    const blocked = await checkApiKeyRateLimit(replacement.id, limits);
    expect(blocked.limitType).toBe('day');
    expect(blocked.headers['X-RateLimit-Remaining-Day']).toBe(0);
    expect(blocked.retryAfter).toBeGreaterThan(0);
    await resetApiKeyRateLimit(old.id);
    expect((await checkApiKeyRateLimit(replacement.id, limits)).allowed).toBe(true);
  });

  it('isolates users and clients and keeps ordinary keys per-key', async () => {
    const limits = { requestsPerMinute: 10, requestsPerDay: 1 };
    for (const key of await Promise.all([
      mint('user-a', 'client-a'),
      mint('user-a', 'client-b'),
      mint('user-b', 'client-a'),
      mint('user-a', 'client-a', 'api'),
      mint('user-a', 'client-a', 'api'),
    ])) {
      expect((await checkApiKeyRateLimit(key.id, limits)).allowed).toBe(true);
    }
  });
});
