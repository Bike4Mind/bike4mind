// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

type CreditRequest = { apiKeyInfo?: { keyId: string } };

type LimiterOptions = {
  limit: (req: CreditRequest) => Promise<number>;
  windowMs: number;
  bucket: string;
  subject: (req: { apiKeyInfo?: { keyId: string } }) => string | undefined;
};

const { captured, mockGetSettingsMap } = vi.hoisted(() => ({
  captured: {} as { limiter?: LimiterOptions; routeOptions?: Record<string, unknown> },
  mockGetSettingsMap: vi.fn(),
}));

vi.mock('@server/middlewares/rateLimit', () => ({
  rateLimit: (options: LimiterOptions) => {
    captured.limiter = options;
    return 'credits-limiter';
  },
}));
vi.mock('@server/middlewares/defineNextRoute', () => ({
  nextRouteForContract: (_contract: unknown, options: Record<string, unknown>) => {
    captured.routeOptions = options;
    return { get: () => 'handler' };
  },
}));
vi.mock('@bike4mind/database', () => ({ adminSettingsRepository: {} }));
vi.mock('@bike4mind/utils', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  getSettingsMap: (...a: unknown[]) => mockGetSettingsMap(...a),
}));

import '../credits';

describe('GET /api/v1/credits dedicated rate limit', () => {
  beforeEach(() => {
    mockGetSettingsMap.mockReset();
  });

  it('runs its own limiter through the contract prelude, after auth and before the handler', () => {
    expect(captured.routeOptions).toMatchObject({ exemptReadsFromDailyRateLimit: true, rateLimit: 'credits-limiter' });
    expect(captured.limiter).toMatchObject({ windowMs: 60_000, bucket: 'credits-read' });
  });

  it('is off by default, so nothing changes until an admin sets it', async () => {
    mockGetSettingsMap.mockResolvedValue({});
    expect(await captured.limiter!.limit({ apiKeyInfo: { keyId: 'k1' } })).toBe(0);
  });

  it('takes its per-minute ceiling from the admin setting', async () => {
    mockGetSettingsMap.mockResolvedValue({ apiRateLimitCreditsPerMin: '30' });
    expect(await captured.limiter!.limit({ apiKeyInfo: { keyId: 'k1' } })).toBe(30);
  });

  it('leaves JWT sessions exempt without reading the setting', async () => {
    mockGetSettingsMap.mockResolvedValue({ apiRateLimitCreditsPerMin: '1' });
    expect(await captured.limiter!.limit({})).toBe(0);
    expect(mockGetSettingsMap).not.toHaveBeenCalled();
  });

  it('counts per API key', () => {
    expect(captured.limiter!.subject({ apiKeyInfo: { keyId: 'k1' } })).toBe('api-key:k1');
    expect(captured.limiter!.subject({})).toBeUndefined();
  });
});
