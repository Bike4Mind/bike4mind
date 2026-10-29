import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ApiKeyScope } from '@bike4mind/common';
import type { AdminSubscriptionsSummary } from '@client/app/utils/adminSubscriptionsFilter';

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

const mockSummary = vi.fn();
vi.mock('@server/admin/subscriptionsList/listAdminSubscriptions', () => ({
  adminSubscriptionsSummary: (...args: unknown[]) => mockSummary(...args),
}));

import handler from '../summary';

const ADMIN = { id: 'a'.repeat(24), isAdmin: true };
type Handler = (req: unknown, res: unknown) => Promise<unknown>;

async function call(query: Record<string, string>, user: Record<string, unknown> = ADMIN) {
  const { req, res } = createMocks({ method: 'GET', query });
  Object.assign(req, { user, logger: { error: vi.fn() } });
  await (handler as unknown as Handler)(req, res);
  return res;
}

describe('GET /api/admin/subscriptions/summary', () => {
  const summary: AdminSubscriptionsSummary = {
    total: 3,
    views: { paying: 2, pastDue: 1, comped: 0, churned: 0 },
    mrr: { currency: 'usd', amount: 4900, unpriced: 1, otherCurrency: 0 },
    pastDueMrr: { currency: 'usd', amount: 1900, unpriced: 0, otherCurrency: 0 },
    searchTruncated: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockSummary.mockResolvedValue(summary);
  });

  it('requires JWT auth with admin scope', () => {
    expect((handler as unknown as { _config: unknown })._config).toEqual({
      auth: 'jwtOnly',
      requiredScopes: [ApiKeyScope.ADMIN],
    });
  });

  it('refuses a non-admin before reading anything', async () => {
    await expect(call({}, { ...ADMIN, isAdmin: false })).rejects.toThrow('Admin access required');
    expect(mockSummary).not.toHaveBeenCalled();
  });

  it('returns the counts and MRR totals for the parsed filter with no-store caching', async () => {
    const res = await call({ status: 'active', interval: 'yearly' });
    expect(res._getJSONData()).toEqual(summary);
    expect(res.getHeader('Cache-Control')).toBe('private, no-store');
    expect(mockSummary).toHaveBeenCalledWith({ status: ['active'], interval: 'yearly' });
  });

  it('rejects an invalid filter with 400', async () => {
    expect((await call({ status: 'bogus' }))._getStatusCode()).toBe(400);
    expect(mockSummary).not.toHaveBeenCalled();
  });
});
