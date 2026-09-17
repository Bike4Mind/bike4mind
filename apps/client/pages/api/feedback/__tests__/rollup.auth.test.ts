import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * The rollup route's auth MODE, against the real baseApi rather than the chain-capture harness
 * rollup.test.ts uses - that harness replaces the middleware wholesale, so it can only pin the
 * option, never show that `jwtOnly` keeps the api-key chain out of the request path.
 *
 * Only baseApi's own dependencies are stubbed here; baseApi itself is the code under test.
 */

const mockRefs = vi.hoisted(() => ({
  apiKeyAuthFactory: vi.fn(() => (_req: unknown, _res: unknown, next: () => void) => next()),
  rateLimitFactory: vi.fn(() => (_req: unknown, _res: unknown, next: () => void) => next()),
  // Stands in for the real JWT verifier, which rejects a request carrying only an API key.
  jwtVerifier: vi.fn((_req: unknown, res: { status: (code: number) => { json: (body: unknown) => unknown } }) =>
    res.status(401).json({ error: 'Unauthorized' })
  ),
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
  auth: (req: unknown, res: unknown, _next: () => void) =>
    mockRefs.jwtVerifier(req, res as Parameters<typeof mockRefs.jwtVerifier>[1]),
}));
vi.mock('@server/middlewares/apiKeyAuth', () => ({ apiKeyAuth: mockRefs.apiKeyAuthFactory }));
vi.mock('@server/middlewares/apiKeyAnomalyDetection', () => ({
  apiKeyAnomalyDetection: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('@server/middlewares/apiKeyRateLimit', () => ({ apiKeyRateLimit: mockRefs.rateLimitFactory }));
vi.mock('@server/analytics/analyticsMiddleware', () => ({
  analyticsMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('@bike4mind/database', () => ({ connectDB: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@server/utils/config', () => ({
  Config: { MONGODB_URI: 'mongodb://localhost/%STAGE%', STAGE: 'test' },
  isDevelopment: () => true,
}));

import { baseApi } from '@server/middlewares/baseApi';

const runWithApiKey = async (options: Record<string, unknown>) => {
  const routeHandler = vi.fn((_req: unknown, res: { status: (code: number) => { json: (body: unknown) => unknown } }) =>
    res.status(200).json({ reached: true })
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const router = baseApi(options as any).get(routeHandler as any);
  const { req, res } = createMocks({
    method: 'GET',
    url: '/api/feedback/rollup',
    headers: { authorization: 'Bearer b4m_live_not_a_real_key' },
  });
  // Not awaited: a middleware that answers the request without calling next() leaves
  // next-connect's own promise pending, so the end of the RESPONSE is the signal to wait on.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  void (router as any)(req, res);
  await vi.waitFor(() => expect((res as unknown as { _isEndCalled: () => boolean })._isEndCalled()).toBe(true));
  return { res, routeHandler };
};

describe('GET /api/feedback/rollup - auth mode against the real baseApi', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('never installs the api-key chain, so a key-bearing request is rejected before the handler', async () => {
    const { res, routeHandler } = await runWithApiKey({ auth: 'jwtOnly' });

    expect(mockRefs.apiKeyAuthFactory).not.toHaveBeenCalled();
    expect(mockRefs.rateLimitFactory).not.toHaveBeenCalled();
    expect(res._getStatusCode()).toBe(401);
    expect(routeHandler).not.toHaveBeenCalled();
  });

  it('installs that chain on a default-auth route - which is what makes the assertion above mean something', async () => {
    await runWithApiKey({});

    expect(mockRefs.apiKeyAuthFactory).toHaveBeenCalled();
    expect(mockRefs.rateLimitFactory).toHaveBeenCalled();
  });
});
