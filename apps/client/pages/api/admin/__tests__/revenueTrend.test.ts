import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ApiKeyScope } from '@bike4mind/common';

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (config?: unknown) => {
    const handlers: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign((req: { method?: string }, res: unknown) => handlers[req.method ?? 'GET']?.(req, res), {
      use: () => chain,
      get: (fn: (req: unknown, res: unknown) => unknown) => ((handlers.GET = fn), chain),
      _config: config,
    });
    return chain;
  },
}));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));
vi.mock('@server/middlewares/rateLimit', () => ({ rateLimit: () => () => undefined }));

const mockAdminRevenueTrend = vi.hoisted(() => vi.fn());
const mockStripeConfigured = vi.hoisted(() => vi.fn());
vi.mock('@server/admin/revenue/adminRevenue', () => ({ adminRevenueTrend: mockAdminRevenueTrend }));
vi.mock('@bike4mind/server-utils/integrations/stripe/stripe', () => ({ isStripeConfigured: mockStripeConfigured }));

import handler from '../revenue/trend';

const ADMIN = { id: 'a'.repeat(24), isAdmin: true };
type Handler = (req: unknown, res: unknown) => Promise<unknown>;

async function call(user: Record<string, unknown> = ADMIN) {
  const { req, res } = createMocks({ method: 'GET' });
  Object.assign(req, { user, logger: { error: vi.fn() } });
  await (handler as unknown as Handler)(req, res);
  return res;
}

describe('GET /api/admin/revenue/trend', () => {
  const trend = [{ date: '2026-10-29', mrr: 1_000, payingCount: 1 }];

  beforeEach(() => {
    vi.clearAllMocks();
    mockStripeConfigured.mockReturnValue(true);
    mockAdminRevenueTrend.mockResolvedValue(trend);
  });

  it('requires JWT auth with admin scope', () => {
    expect((handler as unknown as { _config: unknown })._config).toEqual({
      auth: 'jwtOnly',
      requiredScopes: [ApiKeyScope.ADMIN],
    });
  });

  it('refuses a non-admin before reading anything', async () => {
    await expect(call({ ...ADMIN, isAdmin: false })).rejects.toThrow('Admin access required');
    expect(mockAdminRevenueTrend).not.toHaveBeenCalled();
  });

  it('returns the snapshot trend with no-store caching', async () => {
    const res = await call();
    expect(res._getJSONData()).toEqual({ stripeConfigured: true, trend });
    expect(res.getHeader('Cache-Control')).toBe('private, no-store');
  });

  it('says Stripe is not configured instead of reading on a deployment without it', async () => {
    mockStripeConfigured.mockReturnValue(false);
    expect((await call())._getJSONData()).toEqual({ stripeConfigured: false });
    expect(mockAdminRevenueTrend).not.toHaveBeenCalled();
  });
});
