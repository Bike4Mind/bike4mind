import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks, type RequestMethod } from 'node-mocks-http';
import { ApiKeyScope } from '@bike4mind/common';

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (config: unknown) => {
    const handlers: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign((req: { method?: string }, res: unknown) => handlers[req.method ?? 'GET']?.(req, res), {
      use: () => chain,
      get: (fn: (req: unknown, res: unknown) => unknown) => ((handlers.GET = fn), chain),
      post: (fn: (req: unknown, res: unknown) => unknown) => ((handlers.POST = fn), chain),
      _config: config,
    });
    return chain;
  },
}));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));
const { rateLimitOptions } = vi.hoisted(() => ({ rateLimitOptions: [] as unknown[] }));
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({
  rateLimit: (options: unknown) => (rateLimitOptions.push(options), () => undefined),
}));
vi.mock('@server/admin/savedViews/adapters', () => ({
  SAVED_VIEWS_RATE_LIMIT: { limit: 60, windowMs: 60_000, bucket: 'admin-saved-views' },
  savedViewsDeps: () => ({}),
}));
const mockList = vi.fn();
const mockCreate = vi.fn();
vi.mock('@server/admin/savedViews/savedViews', () => ({
  listSavedViews: (...args: unknown[]) => mockList(...args),
  createSavedView: (...args: unknown[]) => mockCreate(...args),
}));

import handler from '../index';

const ADMIN = { id: 'a'.repeat(24), isAdmin: true };
const VIEW = { version: 1, params: { sortField: 'createdAt', sortOrder: 'desc', limit: 25, status: 'suspended' } };

async function call(
  method: RequestMethod,
  { body, query }: { body?: unknown; query?: Record<string, string> } = {},
  user: Record<string, unknown> = ADMIN
) {
  const { req, res } = createMocks({ method, body, query });
  Object.assign(req, { user });
  await (handler as unknown as (req: unknown, res: unknown) => Promise<unknown>)(req, res);
  return res;
}

describe('/api/admin/saved-views', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockList.mockResolvedValue([]);
    mockCreate.mockImplementation(async (_adminId: string, request: Record<string, unknown>) => ({
      id: 'v1',
      ...request,
      ownerId: ADMIN.id,
      isOwner: true,
    }));
  });

  it('requires JWT admin auth and a per-admin rate limit', async () => {
    expect((handler as unknown as { _config: unknown })._config).toEqual({
      auth: 'jwtOnly',
      requiredScopes: [ApiKeyScope.ADMIN],
    });
    expect(rateLimitOptions).toContainEqual(expect.objectContaining({ limit: 60, windowMs: 60_000 }));
    await expect(call('GET', { query: { surface: 'users' } }, { ...ADMIN, isAdmin: false })).rejects.toThrow(
      'Admin access required'
    );
    expect(mockList).not.toHaveBeenCalled();
  });

  it('lists the caller views for a known surface only', async () => {
    const res = await call('GET', { query: { surface: 'users' } });
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ views: [] });
    expect(mockList).toHaveBeenCalledWith(ADMIN.id, 'users', {});
    await expect(call('GET', { query: { surface: 'orgs' } })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('creates a view and rejects a bad name or view', async () => {
    const res = await call('POST', { body: { surface: 'users', name: 'Suspended', view: VIEW } });
    expect(res._getStatusCode()).toBe(201);
    expect(mockCreate).toHaveBeenCalledWith(
      ADMIN.id,
      { surface: 'users', name: 'Suspended', shared: false, view: VIEW },
      {}
    );

    await expect(call('POST', { body: { surface: 'users', name: ' ', view: VIEW } })).rejects.toMatchObject({
      statusCode: 400,
    });
    await expect(call('POST', { body: { surface: 'users', name: 'x'.repeat(61), view: VIEW } })).rejects.toMatchObject({
      statusCode: 400,
    });
    await expect(
      call('POST', { body: { surface: 'users', name: 'Future', view: { version: 2, params: {} } } })
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });
});
