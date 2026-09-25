import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { createMocks } from 'node-mocks-http';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import {
  createMongoServer,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../../packages/database/src/__test__/createMongoServer';

/**
 * The daily-report rate limit, driven through the real baseApi and the real Mongo-backed limiter:
 * the counter lives in the Cache collection, so a mocked store would prove nothing about whether
 * the increment bounds anything. `requiredScopes` gates API-key callers only and the ability check
 * only asks who you are, so this limiter is the only thing bounding how often an authorized admin
 * can re-run a report that fans over every user.
 *
 * Stubbed: baseApi's environment (logging, the JWT verifier, analytics, connectDB) and the report
 * generation itself. `rateLimit` and `cacheRepository` stay real - the api-key chain falls straight
 * through for a keyless request, which is the path under test.
 */

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const mockRefs = vi.hoisted(() => ({
  // Whichever principal the JWT verifier stub authenticates for the next request.
  currentUserId: 'daily-report-user-a',
  generateDailyReport: vi.fn().mockResolvedValue({ rows: [] }),
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
    req.user = { id: mockRefs.currentUserId, isAdmin: true };
    // Stands in for the CASL ability the real verifier attaches; the route's own read check is
    // not what this file is about.
    req.ability = { can: () => true };
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
// `cacheRepository` stays real against the in-memory server - it is the limiter's counter and the
// whole point of the file. The report generation is stubbed: filling a window means running the
// allowed request count for real, and generateDailyReport has its own tests.
vi.mock('@bike4mind/database', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/database')>()),
  connectDB: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@bike4mind/services', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/services')>();
  return {
    ...actual,
    counterService: { ...actual.counterService, generateDailyReport: mockRefs.generateDailyReport },
  };
});

import { cacheRepository } from '@bike4mind/database';
import handler, { DAILY_REPORT_RATE_LIMIT as ROUTE_LIMIT } from '@pages/api/users/report';

// The route's own window, and the ceiling Retry-After has to fall under.
const ONE_MINUTE_MS = 60 * 1000;

let mongoServer: MongoMemoryServer;

// The principal whose window gets filled. Unique per run so a re-run inside the same window
// does not inherit the previous run's counter from Mongo.
const EXHAUSTED_USER = `daily-report-principal-${Date.now()}`;

// Every request asks for a different date. This route caches nothing today - generateDailyReport
// runs on every allowed request - so varying the date is what keeps the "not executed on the
// refused request" assertion from going quietly vacuous if a result cache is ever added.
let dayOfMonth = 0;

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
  const date = `2026-01-${String((dayOfMonth++ % 28) + 1).padStart(2, '0')}`;
  const { req, res } = createMocks({ method: 'POST', url: '/api/users/report', query: { date } });
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

describe('POST /api/users/report - per-principal rate limit', () => {
  /**
   * Deliberately one test rather than one per claim. The route's window and this file's
   * testTimeout are both 60s, and `testTimeout` is per-test: an exhausted window carried across
   * an `it` boundary would get a fresh 60s budget, so a slow run could let the window roll and
   * then read the resulting 200 as a passing assertion. Inside a single test the window cannot
   * roll before the timeout fires, so a slow run goes red instead of green-for-the-wrong-reason.
   */
  it('serves the last request inside the window, then 429s that principal only', async () => {
    // Read before the first request, so it is never later than the window the limiter opens.
    const windowOpenedAt = Date.now();
    // One short of the limit, so the route's own request is the one that fills it - a limiter
    // that refused early, or an off-by-one, fails here rather than passing quietly.
    await fillWindow(EXHAUSTED_USER, ROUTE_LIMIT - 1);

    mockRefs.generateDailyReport.mockClear();
    expect((await callAs(EXHAUSTED_USER))._getStatusCode()).toBe(200);
    // Establishes that an allowed request does reach the report, so the assertion below is about
    // the refusal rather than about the stub never being reachable.
    expect(mockRefs.generateDailyReport).toHaveBeenCalledTimes(1);

    mockRefs.generateDailyReport.mockClear();
    const limited = await callAs(EXHAUSTED_USER);
    expect(limited._getStatusCode()).toBe(429);
    // The refusal has to come before the report: a limiter that generated it and then answered
    // 429 would leave the fan-over-every-user scan this route is being bounded for unbounded.
    expect(mockRefs.generateDailyReport).not.toHaveBeenCalled();

    // Pinned against how much of the window has actually elapsed, not just `> 0`: Math.max(1, ...)
    // in the middleware makes a bare `> 0` pass for a mistyped windowMs too. Measuring elapsed
    // after the response only ever makes this floor more conservative, never wrong.
    const elapsedSeconds = (Date.now() - windowOpenedAt) / 1000;
    const remainingWindowSeconds = ONE_MINUTE_MS / 1000 - elapsedSeconds;
    const retryAfter = Number(limited.getHeader('Retry-After'));
    expect(retryAfter).toBeGreaterThanOrEqual(Math.max(1, Math.floor(remainingWindowSeconds)));
    expect(retryAfter).toBeLessThanOrEqual(ONE_MINUTE_MS / 1000);

    // Same route, same window, different principal: the limiter keys on req.user.id, which is
    // the whole claim being made about the admin path.
    expect((await callAs(`${EXHAUSTED_USER}-other`))._getStatusCode()).toBe(200);
    // The other direction of that claim, and the half that is limiter-sensitive on its own:
    // serving the second admin neither reset nor charged the first admin's window.
    expect((await callAs(EXHAUSTED_USER))._getStatusCode()).toBe(429);

    // Pinned to this route's own bucket: a route sharing another route's bucket string would
    // still pass every assertion above while counting against the wrong counter in production.
    expect(await cacheRepository.findByKey(`rate-limit:${EXHAUSTED_USER}:users-daily-report`)).toBeTruthy();
  });
});
