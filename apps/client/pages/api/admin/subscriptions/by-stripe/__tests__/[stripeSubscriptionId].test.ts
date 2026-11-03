import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ApiKeyScope } from '@bike4mind/common';

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (config?: unknown) => {
    const handlers: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign((req: { method?: string }, res: unknown) => handlers[req.method ?? 'GET']?.(req, res), {
      get: (fn: (req: unknown, res: unknown) => unknown) => ((handlers.GET = fn), chain),
      _config: config,
    });
    return chain;
  },
}));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));

const mockFindByStripeId = vi.fn();
vi.mock('@bike4mind/server-utils/models/Subscription', () => ({
  subscriptionRepository: { findByStripeSubscriptionId: (...args: unknown[]) => mockFindByStripeId(...args) },
}));

import handler from '../[stripeSubscriptionId]';

const ADMIN = { id: 'a'.repeat(24), isAdmin: true };
type Handler = (req: unknown, res: unknown) => Promise<unknown>;

async function call(user: Record<string, unknown> = ADMIN) {
  const { req, res } = createMocks({ method: 'GET', query: { stripeSubscriptionId: 'sub_123' } });
  Object.assign(req, { user });
  await (handler as unknown as Handler)(req, res);
  return res;
}

describe('GET /api/admin/subscriptions/by-stripe/[stripeSubscriptionId]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindByStripeId.mockResolvedValue({ id: 'c'.repeat(24) });
  });

  it('requires JWT auth with admin scope', () => {
    expect((handler as unknown as { _config: unknown })._config).toEqual({
      auth: 'jwtOnly',
      requiredScopes: [ApiKeyScope.ADMIN],
    });
  });

  it('refuses a non-admin', async () => {
    await expect(call({ ...ADMIN, isAdmin: false })).rejects.toThrow('Admin access required');
    expect(mockFindByStripeId).not.toHaveBeenCalled();
  });

  it('404s for an unknown Stripe id', async () => {
    mockFindByStripeId.mockResolvedValue(null);
    await expect(call()).rejects.toMatchObject({ statusCode: 404 });
  });

  it('returns the Mongo id with no-store caching', async () => {
    const res = await call();
    expect(mockFindByStripeId).toHaveBeenCalledWith('sub_123');
    expect(res.getHeader('Cache-Control')).toBe('private, no-store');
    expect(res._getJSONData()).toEqual({ id: 'c'.repeat(24) });
  });
});
