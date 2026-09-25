import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { createMocks } from 'node-mocks-http';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import {
  createMongoServer,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../../packages/database/src/__test__/createMongoServer';

/**
 * The rollup route's rate limit, driven through the real baseApi and the real Mongo-backed
 * limiter: the counter lives in the Cache collection, so a mocked store would prove nothing
 * about whether the increment actually bounds anything.
 *
 * Stubbed: baseApi's own environment (logging, the JWT verifier, analytics, connectDB) and the
 * aggregate the handler runs (see below). `rateLimit` and `cacheRepository` are the code under
 * test and stay real.
 */

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const mockRefs = vi.hoisted(() => ({
  // Whichever principal the JWT verifier stub authenticates for the next request.
  currentUserId: 'rate-limit-user-a',
}));

vi.mock('@server/services/gears/toolGearObserver', () => ({ registerToolGearObserver: vi.fn() }));
vi.mock('@server/middlewares/logging', () => ({
  logging: (req: Record<string, unknown>, _res: unknown, next: () => void) => {
    const logger: Record<string, unknown> = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    logger.withMetadata = vi.fn(() => logger);
    logger.updateMetadata = vi.fn();
    req.logger = logger;
    req.requestId = 'test-request-id';
    next();
  },
}));
vi.mock('@server/auth/auth', () => ({
  authMiddleware: [],
  auth: (req: Record<string, unknown>, _res: unknown, next: () => void) => {
    req.user = { id: mockRefs.currentUserId };
    next();
  },
}));
vi.mock('@server/analytics/analyticsMiddleware', () => ({
  analyticsMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('@server/utils/config', () => ({
  Config: { MONGODB_URI: 'mongodb://localhost/%STAGE%', STAGE: 'test' },
  isDevelopment: () => true,
}));
// `cacheRepository` stays real against the in-memory server - it is the limiter's counter and
// the whole point of the file. The rollup aggregate itself is stubbed: filling a window means
// running the allowed request count for real, and rollup.ownership.integration.test.ts already
// owns what the pipeline returns.
vi.mock('@bike4mind/database', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/database')>()),
  connectDB: vi.fn().mockResolvedValue(undefined),
  executeFacetCompatible: vi.fn().mockResolvedValue([]),
}));

import { executeFacetCompatible } from '@bike4mind/database';
import handler, { FEEDBACK_ROLLUP_RATE_LIMIT as ROUTE_LIMIT } from '@pages/api/feedback/rollup';

// The route's own window, and the ceiling Retry-After has to fall under.
const ONE_MINUTE_MS = 60 * 1000;

const FROM = '2026-01-01T00:00:00.000Z';
const TO = '2026-02-01T00:00:00.000Z';

let mongoServer: MongoMemoryServer;

// Driven past the limit by the first test and left that way: the counter lives in Mongo for the
// whole window, so the per-principal test contrasts against it without re-filling anything.
const EXHAUSTED_USER = `rate-limit-principal-${Date.now()}`;

/**
 * Fills the window through the route, not through the limiter's own primitive: the counter key,
 * the bucket and the window then all come from the route's configuration instead of a copy of it
 * here that would keep passing after the route's changed.
 */
const fillWindow = async (userId: string, times: number) => {
  for (let i = 0; i < times; i++) {
    expect((await callAs(userId))._getStatusCode()).toBe(200);
  }
};

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});

// Safe to overlap only for one principal at a time: the JWT stub reads `currentUserId` when the
// request reaches it, not when it is issued.
const callAs = async (userId: string) => {
  mockRefs.currentUserId = userId;
  const { req, res } = createMocks({
    method: 'GET',
    url: '/api/feedback/rollup',
    query: { from: FROM, to: TO },
  });
  // The END OF THE RESPONSE is the completion signal, not next-connect's own promise: a
  // middleware that answers without calling next() leaves that promise pending forever. But it
  // still has to be observed - an error that escapes the error handler (a throw inside it, say)
  // ends nothing, and discarding the rejection turns that into a wait that never finishes.
  let failure: unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  void (handler as any)(req, res).catch((error: unknown) => {
    failure = error;
  });

  // Deliberately unbounded: MONGO_TEST_TIMEOUT_MS above is the only budget this file gets. A
  // second, tighter one nested here expires first whenever the real-Mongo cold start runs long
  // under suite contention, and reports it as `expected false to be true` - a red that names
  // nothing. A request that genuinely never answers still fails, on the file's own budget.
  const mockRes = res as unknown as { _isEndCalled: () => boolean };
  while (!mockRes._isEndCalled()) {
    if (failure) throw failure;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  return res;
};

describe('GET /api/feedback/rollup - per-principal rate limit', () => {
  it('serves the last request inside the window, then answers 429 with Retry-After', async () => {
    // One short of the limit, so the route's own request is the one that fills it - a limiter
    // that refused early, or an off-by-one, fails here rather than passing quietly.
    await fillWindow(EXHAUSTED_USER, ROUTE_LIMIT - 1);

    expect((await callAs(EXHAUSTED_USER))._getStatusCode()).toBe(200);

    vi.mocked(executeFacetCompatible).mockClear();
    const limited = await callAs(EXHAUSTED_USER);
    expect(limited._getStatusCode()).toBe(429);
    // The refusal has to come before the aggregate: a limiter that ran the pipeline and then
    // answered 429 would leave the work this route is being bounded for unbounded.
    expect(executeFacetCompatible).not.toHaveBeenCalled();
    // Pinned to the window, not just positive - Math.max(1, ...) in the middleware makes a bare
    // `> 0` pass for any windowMs, including a mistyped one.
    const retryAfter = Number(limited.getHeader('Retry-After'));
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(ONE_MINUTE_MS / 1000);
  });

  it('keys the counter per principal, so a second user is unaffected by an exhausted window', async () => {
    // Same route, same window, different principal: the limiter keys on req.user.id, which is
    // the whole claim being made about the jwtOnly path.
    const other = await callAs(`${EXHAUSTED_USER}-other`);

    expect(other._getStatusCode()).toBe(200);

    // The other direction of the same claim, and the half that is limiter-sensitive on its own:
    // serving the second user neither reset nor charged the first user's window.
    expect((await callAs(EXHAUSTED_USER))._getStatusCode()).toBe(429);
  });
});
