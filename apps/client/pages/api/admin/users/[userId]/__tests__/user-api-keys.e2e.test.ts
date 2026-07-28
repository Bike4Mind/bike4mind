import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import { createMongoServer } from '../../../../../../../../packages/database/src/__test__/createMongoServer';
import { userApiKeyRepository } from '@bike4mind/database/auth';
import { checkApiKeyRateLimit } from '@server/utils/apiKeyRateLimitCheck';
import { ApiKeyScope } from '@bike4mind/common';

/**
 * Agreement test for the admin key list, driving the REAL repository, model,
 * and cache against createMongoServer. The unit test mocks the service, so
 * only this test proves the serialization invariant the route depends on:
 * hydrated docs pass through the model's toJSON transform and keyHash never
 * reaches the wire (a .lean()/POJO regression on any layer of this path would
 * fail here). It also pins liveUsage against the real enforcer's counters.
 * Consumes the built dist, so `pnpm turbo:core:build` must be current.
 */

const { mockUserFind } = vi.hoisted(() => ({ mockUserFind: vi.fn() }));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const h: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign(
      (req: unknown, res: unknown) => h[(req as { method?: string }).method ?? 'GET']?.(req, res),
      {
        use: () => chain,
        get: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((h.GET = fns[fns.length - 1]), chain),
      }
    );
    return chain;
  },
}));

vi.mock('@server/middlewares/asyncHandler', () => ({
  asyncHandler: (fn: (req: unknown, res: unknown) => unknown) => fn,
}));

// Keep the real package (cacheRepository backs the live counters); stub only
// the user lookup so no User doc fixture is needed.
vi.mock('@bike4mind/database', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/database')>();
  return { ...actual, userRepository: { findById: (...a: unknown[]) => mockUserFind(...a) } };
});

import handler from '../user-api-keys';

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
}, 30000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
}, 30000);
afterEach(async () => {
  await mongoose.connection.dropDatabase();
  mockUserFind.mockReset();
});

const run = (userId: string) => {
  const { req, res } = createMocks({ method: 'GET', query: { userId } });
  (req as Record<string, unknown>).user = { id: 'admin1', isAdmin: true };
  return { res, promise: (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res) };
};

describe('GET /api/admin/users/:userId/user-api-keys (end-to-end, real model + Mongo)', () => {
  it('serializes real key docs without keyHash and reports the enforcer-visible counters', async () => {
    mockUserFind.mockResolvedValue({ id: 'target-user' });
    const created = await userApiKeyRepository.create({
      userId: 'target-user',
      name: 'wedgeable key',
      keyHash: '$2b$12$abcdefghijklmnopqrstuv',
      keyPrefix: 'b4m_live_e2e00001',
      scopes: [ApiKeyScope.AI_CHAT],
      metadata: { createdFrom: 'dashboard' },
    });

    // Real traffic through the real enforcer: two requests land on the counters.
    await checkApiKeyRateLimit(created.id, { requestsPerMinute: 5, requestsPerDay: 100 });
    await checkApiKeyRateLimit(created.id, { requestsPerMinute: 5, requestsPerDay: 100 });

    const { res, promise } = run('target-user');
    await promise;

    expect(res._getStatusCode()).toBe(200);
    // Reproduce the wire format: real res.json serializes via JSON.stringify,
    // which is what applies the model's toJSON transform.
    const body = JSON.parse(JSON.stringify(res._getJSONData()));

    expect(body.apiKeys).toHaveLength(1);
    const [key] = body.apiKeys;
    expect(key.keyPrefix).toBe('b4m_live_e2e00001');
    expect(key.keyHash).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('$2b$12$');

    const usage = body.liveUsage[created.id];
    expect(usage).toMatchObject({ minute: 2, day: 2 });
    // Fixed-window resets are the counters' real expiry (epoch seconds): the
    // minute window ends ~60s out, the day window ~24h out.
    const nowSeconds = Math.floor(Date.now() / 1000);
    expect(usage.minuteResetAt).toBeGreaterThan(nowSeconds);
    expect(usage.minuteResetAt).toBeLessThanOrEqual(nowSeconds + 60);
    expect(usage.dayResetAt).toBeGreaterThan(nowSeconds);
    expect(usage.dayResetAt).toBeLessThanOrEqual(nowSeconds + 86_400);
  });
});
