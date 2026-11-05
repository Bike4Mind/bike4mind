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

const mockRead = vi.hoisted(() => vi.fn());
vi.mock('@server/admin/subscriptionStripe/getAdminSubscriptionStripe', () => ({
  getAdminSubscriptionStripe: mockRead,
}));

import handler from '../stripe';

const ID = 'b'.repeat(24);
const ADMIN = { id: 'a'.repeat(24), isAdmin: true };
type Handler = (req: unknown, res: unknown) => Promise<unknown>;

async function call(query: Record<string, string> = { id: ID }, user: Record<string, unknown> = ADMIN) {
  const { req, res } = createMocks({ method: 'GET', query });
  Object.assign(req, { user, logger: { error: vi.fn() } });
  await (handler as unknown as Handler)(req, res);
  return res;
}

describe('GET /api/admin/subscriptions/[id]/stripe', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRead.mockResolvedValue({ stripeConfigured: true, kind: 'comp' });
  });

  it('requires JWT auth with admin scope', () => {
    expect((handler as unknown as { _config: unknown })._config).toEqual({
      auth: 'jwtOnly',
      requiredScopes: [ApiKeyScope.ADMIN],
    });
  });

  it('403s a delegated admin without reading, matching the detail route', async () => {
    const delegate = { id: 'c'.repeat(24), isAdmin: false, adminPermissions: ['support:read'] };
    await expect(call({ id: ID }, delegate)).rejects.toMatchObject({ statusCode: 403 });
    expect(mockRead).not.toHaveBeenCalled();
  });

  it('404s a malformed id without reading', async () => {
    await expect(call({ id: 'nope' })).rejects.toMatchObject({ statusCode: 404 });
    expect(mockRead).not.toHaveBeenCalled();
  });

  it('404s an unknown subscription', async () => {
    mockRead.mockResolvedValue(null);
    await expect(call()).rejects.toMatchObject({ statusCode: 404 });
  });

  it('returns the payload with no-store caching and passes the fresh flag', async () => {
    const res = await call({ id: ID, fresh: '1' });
    expect(mockRead).toHaveBeenCalledWith(ID, expect.objectContaining({ fresh: true }));
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ stripeConfigured: true, kind: 'comp' });
    expect(res.getHeader('Cache-Control')).toBe('private, no-store');
  });

  it('maps any Stripe error to 502 and rethrows anything else', async () => {
    mockRead.mockRejectedValueOnce(Object.assign(new Error('down'), { type: 'StripeConnectionError' }));
    const res = await call();
    expect(res._getStatusCode()).toBe(502);
    expect(res._getJSONData()).toEqual({ message: 'Stripe request failed' });

    mockRead.mockRejectedValueOnce(Object.assign(new Error('no access'), { type: 'StripePermissionError' }));
    const permissionRes = await call();
    expect(permissionRes._getStatusCode()).toBe(502);
    expect(permissionRes._getJSONData()).toEqual({ message: 'Stripe request failed' });

    mockRead.mockRejectedValueOnce(new Error('our bug'));
    await expect(call()).rejects.toThrow('our bug');
  });
});
