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

const mockDetail = vi.fn();
vi.mock('@server/admin/subscriptionDetail/getAdminSubscriptionDetail', () => ({
  getAdminSubscriptionDetail: (...args: unknown[]) => mockDetail(...args),
}));

import handler from '../index';

const ADMIN = { id: 'a'.repeat(24), isAdmin: true };
type Handler = (req: unknown, res: unknown) => Promise<unknown>;

async function call(user: Record<string, unknown> = ADMIN) {
  const { req, res } = createMocks({ method: 'GET', query: { id: 'b'.repeat(24) } });
  Object.assign(req, { user });
  await (handler as unknown as Handler)(req, res);
  return res;
}

describe('GET /api/admin/subscriptions/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDetail.mockResolvedValue({ subscription: { id: 'b'.repeat(24) } });
  });

  it('requires JWT auth with admin scope', () => {
    expect((handler as unknown as { _config: unknown })._config).toEqual({
      auth: 'jwtOnly',
      requiredScopes: [ApiKeyScope.ADMIN],
    });
  });

  it('refuses a non-admin before reading anything', async () => {
    await expect(call({ ...ADMIN, isAdmin: false })).rejects.toThrow('Admin access required');
    expect(mockDetail).not.toHaveBeenCalled();
  });

  it('404s when the subscription does not exist', async () => {
    mockDetail.mockResolvedValue(null);
    await expect(call()).rejects.toMatchObject({ statusCode: 404 });
  });

  it('returns the detail with no-store caching', async () => {
    const res = await call();
    expect(mockDetail).toHaveBeenCalledWith('b'.repeat(24));
    expect(res._getStatusCode()).toBe(200);
    expect(res.getHeader('Cache-Control')).toBe('private, no-store');
    expect(res._getJSONData()).toEqual({ subscription: { id: 'b'.repeat(24) } });
  });
});
