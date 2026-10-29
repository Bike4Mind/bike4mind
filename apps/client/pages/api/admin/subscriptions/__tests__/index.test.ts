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

const mockList = vi.fn();
vi.mock('@server/admin/subscriptionsList/listAdminSubscriptions', () => ({
  listAdminSubscriptions: (...args: unknown[]) => mockList(...args),
}));

import handler from '../index';

const ADMIN = { id: 'a'.repeat(24), isAdmin: true };
type Handler = (req: unknown, res: unknown) => Promise<unknown>;

async function call(query: Record<string, string>, user: Record<string, unknown> = ADMIN) {
  const { req, res } = createMocks({ method: 'GET', query });
  Object.assign(req, { user, logger: { error: vi.fn() } });
  await (handler as unknown as Handler)(req, res);
  return res;
}

describe('GET /api/admin/subscriptions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockList.mockResolvedValue({ subscriptions: [], total: 0, page: 1, totalPages: 0, searchTruncated: false });
  });

  it('requires JWT auth with admin scope', () => {
    expect((handler as unknown as { _config: unknown })._config).toEqual({
      auth: 'jwtOnly',
      requiredScopes: [ApiKeyScope.ADMIN],
    });
  });

  it('refuses a non-admin before reading anything', async () => {
    await expect(call({}, { ...ADMIN, isAdmin: false })).rejects.toThrow('Admin access required');
    expect(mockList).not.toHaveBeenCalled();
  });

  it('applies the defaults and sets no-store caching', async () => {
    const res = await call({});
    expect(res._getStatusCode()).toBe(200);
    expect(res.getHeader('Cache-Control')).toBe('private, no-store');
    expect(mockList).toHaveBeenCalledWith({ page: 1, limit: 25, sortField: 'createdAt', sortOrder: 'desc' });
  });

  it('passes the parsed filter, page and sort to the list', async () => {
    await call({
      status: 'past_due',
      ownerType: 'Organization',
      source: 'stripe',
      renews: 'next7',
      search: ' jane ',
      page: '3',
      limit: '50',
      sortField: 'periodEndsAt',
      sortOrder: 'asc',
    });
    expect(mockList).toHaveBeenCalledWith({
      status: ['past_due'],
      ownerType: 'Organization',
      source: 'stripe',
      renews: 'next7',
      search: 'jane',
      page: 3,
      limit: 50,
      sortField: 'periodEndsAt',
      sortOrder: 'asc',
    });
  });

  it('turns a bare status string into an array', async () => {
    await call({ status: 'active' });
    expect(mockList.mock.calls[0][0]).toMatchObject({ status: ['active'] });
  });

  it('rejects an invalid page size or status with 400', async () => {
    expect((await call({ limit: '7' }))._getStatusCode()).toBe(400);
    expect((await call({ status: 'bogus' }))._getStatusCode()).toBe(400);
    expect(mockList).not.toHaveBeenCalled();
  });
});
