// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

type CreditRequest = { apiKeyInfo?: { keyId: string } };

type LimiterOptions = {
  limit: (req: CreditRequest) => Promise<number>;
  windowMs: number;
  bucket: string;
  subject: (req: { apiKeyInfo?: { keyId: string } }) => string | undefined;
};

type Middleware = (req: unknown, res: unknown, next: (err?: unknown) => void) => Promise<void>;

const { captured, mockGetSettingsMap, mockTryIncrement } = vi.hoisted(() => ({
  captured: {} as { limiter?: LimiterOptions; middleware?: Middleware; routeOptions?: Record<string, unknown> },
  mockGetSettingsMap: vi.fn(),
  mockTryIncrement: vi.fn(),
}));

// Wraps the real middleware so the resolver is also exercised against its enforcement contract.
vi.mock('@server/middlewares/rateLimit', async () => {
  const real = await vi.importActual<{ rateLimit: (o: LimiterOptions) => Middleware }>(
    '@bike4mind/server-utils/middlewares/rateLimit'
  );
  return {
    rateLimit: (options: LimiterOptions) => {
      captured.limiter = options;
      captured.middleware = real.rateLimit(options);
      return captured.middleware;
    },
  };
});
vi.mock('@server/middlewares/defineNextRoute', () => ({
  nextRouteForContract: (_contract: unknown, options: Record<string, unknown>) => {
    captured.routeOptions = options;
    return { get: () => 'handler' };
  },
}));
vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  cacheRepository: { tryIncrementWithinLimitFixedWindow: (...a: unknown[]) => mockTryIncrement(...a) },
}));
vi.mock('@bike4mind/utils', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  getSettingsMap: (...a: unknown[]) => mockGetSettingsMap(...a),
}));

import '../credits';

describe('GET /api/v1/credits dedicated rate limit', () => {
  beforeEach(() => {
    mockGetSettingsMap.mockReset();
    mockTryIncrement.mockReset();
  });

  async function runMiddleware(req: CreditRequest) {
    const next = vi.fn();
    const res = { setHeader: vi.fn() };
    await captured.middleware!({ ...req, url: '/api/v1/credits' }, res, next);
    return next;
  }

  it('runs its own limiter through the contract prelude, after auth and before the handler', () => {
    expect(captured.routeOptions).toMatchObject({
      exemptReadsFromDailyRateLimit: true,
      rateLimit: captured.middleware,
    });
    expect(captured.limiter).toMatchObject({ windowMs: 60_000, bucket: 'credits-read' });
  });

  it('is off by default, so nothing changes until an admin sets it', async () => {
    mockGetSettingsMap.mockResolvedValue({});
    expect(await captured.limiter!.limit({ apiKeyInfo: { keyId: 'k1' } })).toBe(Infinity);
  });

  it('treats an explicit 0 setting as off', async () => {
    mockGetSettingsMap.mockResolvedValue({ apiRateLimitCreditsPerMin: '0' });
    expect(await captured.limiter!.limit({ apiKeyInfo: { keyId: 'k1' } })).toBe(Infinity);
  });

  it('takes its per-minute ceiling from the admin setting', async () => {
    mockGetSettingsMap.mockResolvedValue({ apiRateLimitCreditsPerMin: '30' });
    expect(await captured.limiter!.limit({ apiKeyInfo: { keyId: 'k1' } })).toBe(30);
  });

  it('leaves JWT sessions exempt without reading the setting', async () => {
    mockGetSettingsMap.mockResolvedValue({ apiRateLimitCreditsPerMin: '1' });
    expect(await captured.limiter!.limit({})).toBe(Infinity);
    expect(mockGetSettingsMap).not.toHaveBeenCalled();
  });

  it('lets JWT sessions through the real middleware without touching the bucket', async () => {
    const next = await runMiddleware({});
    expect(next).toHaveBeenCalledWith();
    expect(mockTryIncrement).not.toHaveBeenCalled();
  });

  it('lets API-key callers through the real middleware when the setting is unset', async () => {
    mockGetSettingsMap.mockResolvedValue({});
    const next = await runMiddleware({ apiKeyInfo: { keyId: 'k1' } });
    expect(next).toHaveBeenCalledWith();
    expect(mockTryIncrement).not.toHaveBeenCalled();
  });

  it('enforces a positive setting per key through the real middleware', async () => {
    mockGetSettingsMap.mockResolvedValue({ apiRateLimitCreditsPerMin: '2' });
    mockTryIncrement.mockResolvedValue({ success: true, expiresAt: new Date(Date.now() + 60_000) });
    const next = await runMiddleware({ apiKeyInfo: { keyId: 'k1' } });
    expect(next).toHaveBeenCalledWith();
    expect(mockTryIncrement).toHaveBeenCalledWith('rate-limit:api-key:k1:credits-read', 2, 60_000);
  });

  it('counts per API key', () => {
    expect(captured.limiter!.subject({ apiKeyInfo: { keyId: 'k1' } })).toBe('api-key:k1');
    expect(captured.limiter!.subject({})).toBeUndefined();
  });
});
