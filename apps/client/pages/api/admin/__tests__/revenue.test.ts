import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ApiKeyScope } from '@bike4mind/common';

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (config?: unknown) => {
    const handlers: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const middlewares: ((req: unknown, res: unknown, next: () => void) => unknown)[] = [];
    const chain = Object.assign(
      async (req: { method?: string }, res: unknown) => {
        for (const middleware of middlewares) await middleware(req, res, () => undefined);
        return handlers[req.method ?? 'GET']?.(req, res);
      },
      {
        use: (middleware: (typeof middlewares)[number]) => (middlewares.push(middleware), chain),
        get: (fn: (req: unknown, res: unknown) => unknown) => ((handlers.GET = fn), chain),
        _config: config,
      }
    );
    return chain;
  },
}));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));
vi.mock('@server/middlewares/rateLimit', () => ({ rateLimit: () => () => undefined }));

const mockAdminRevenue = vi.hoisted(() => vi.fn());
const mockAdminRevenueTrend = vi.hoisted(() => vi.fn());
const mockStripeConfigured = vi.hoisted(() => vi.fn());
vi.mock('@server/admin/revenue/adminRevenue', () => ({
  adminRevenue: mockAdminRevenue,
  adminRevenueTrend: mockAdminRevenueTrend,
}));
vi.mock('@bike4mind/server-utils/integrations/stripe/stripe', () => ({ isStripeConfigured: mockStripeConfigured }));

import handler from '../revenue';

const ADMIN = { id: 'a'.repeat(24), isAdmin: true };
type Handler = (req: unknown, res: unknown) => Promise<unknown>;

async function call(query: Record<string, string>, user: Record<string, unknown> = ADMIN) {
  const { req, res } = createMocks({ method: 'GET', query });
  Object.assign(req, { user, logger: { error: vi.fn() } });
  await (handler as unknown as Handler)(req, res);
  return res;
}

describe('GET /api/admin/revenue', () => {
  const data = { stripeConfigured: true, range: '90d', trend: [] };

  beforeEach(() => {
    vi.clearAllMocks();
    mockStripeConfigured.mockReturnValue(true);
    mockAdminRevenue.mockResolvedValue(data);
  });

  it('requires JWT auth with admin scope', () => {
    expect((handler as unknown as { _config: unknown })._config).toEqual({
      auth: 'jwtOnly',
      requiredScopes: [ApiKeyScope.ADMIN],
      allowedMethods: ['GET'],
    });
  });

  it('refuses a non-admin before reading anything', async () => {
    await expect(call({}, { ...ADMIN, isAdmin: false })).rejects.toThrow(/missing permission/i);
    expect(mockAdminRevenue).not.toHaveBeenCalled();
  });

  it('returns the revenue for the requested range with no-store caching', async () => {
    const res = await call({ range: '90d' });
    expect(res._getJSONData()).toEqual(data);
    expect(res.getHeader('Cache-Control')).toBe('private, no-store');
    expect(mockAdminRevenue).toHaveBeenCalledWith('90d');
  });

  it('defaults to 30 days', async () => {
    await call({});
    expect(mockAdminRevenue).toHaveBeenCalledWith('30d');
  });

  it('returns only the snapshot trend for part=trend, without computing the live totals', async () => {
    const trend = [{ date: '2026-10-29', mrr: 1_000, payingCount: 1 }];
    mockAdminRevenueTrend.mockResolvedValue(trend);
    const res = await call({ part: 'trend' });
    expect(res._getJSONData()).toEqual({ stripeConfigured: true, trend });
    expect(res.getHeader('Cache-Control')).toBe('private, no-store');
    expect(mockAdminRevenue).not.toHaveBeenCalled();
  });

  it('rejects an unknown part with 400', async () => {
    expect((await call({ part: 'everything' }))._getStatusCode()).toBe(400);
    expect(mockAdminRevenueTrend).not.toHaveBeenCalled();
  });

  it('rejects an unknown range with 400', async () => {
    expect((await call({ range: '7d' }))._getStatusCode()).toBe(400);
    expect(mockAdminRevenue).not.toHaveBeenCalled();
  });

  it('says Stripe is not configured instead of reading on a deployment without it', async () => {
    mockStripeConfigured.mockReturnValue(false);
    const res = await call({});
    expect(res._getJSONData()).toEqual({ stripeConfigured: false });
    expect(mockAdminRevenue).not.toHaveBeenCalled();
    expect((await call({ part: 'trend' }))._getJSONData()).toEqual({ stripeConfigured: false });
    expect(mockAdminRevenueTrend).not.toHaveBeenCalled();
  });
});
