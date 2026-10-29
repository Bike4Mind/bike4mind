import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks, type RequestMethod } from 'node-mocks-http';
import { ApiKeyScope } from '@bike4mind/common';

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (config: unknown) => {
    const handlers: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign((req: { method?: string }, res: unknown) => handlers[req.method ?? 'GET']?.(req, res), {
      use: () => chain,
      patch: (fn: (req: unknown, res: unknown) => unknown) => ((handlers.PATCH = fn), chain),
      delete: (fn: (req: unknown, res: unknown) => unknown) => ((handlers.DELETE = fn), chain),
      _config: config,
    });
    return chain;
  },
}));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({ rateLimit: () => () => undefined }));
vi.mock('@server/admin/savedViews/adapters', () => ({
  SAVED_VIEWS_RATE_LIMIT: { limit: 60, windowMs: 60_000, bucket: 'admin-saved-views' },
  savedViewsDeps: () => ({}),
}));
const mockUpdate = vi.fn();
const mockDelete = vi.fn();
vi.mock('@server/admin/savedViews/savedViews', () => ({
  updateSavedView: (...args: unknown[]) => mockUpdate(...args),
  deleteSavedView: (...args: unknown[]) => mockDelete(...args),
}));

import handler from '../[id]';

const ADMIN = { id: 'a'.repeat(24), isAdmin: true };
const VIEW_ID = 'c'.repeat(24);

async function call(method: RequestMethod, query: Record<string, string>, body?: unknown, user = ADMIN) {
  const { req, res } = createMocks({ method, query, body });
  Object.assign(req, { user });
  await (handler as unknown as (req: unknown, res: unknown) => Promise<unknown>)(req, res);
  return res;
}

describe('/api/admin/saved-views/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdate.mockResolvedValue({ id: VIEW_ID, name: 'Renamed' });
    mockDelete.mockResolvedValue(undefined);
  });

  it('requires JWT admin auth', async () => {
    expect((handler as unknown as { _config: unknown })._config).toEqual({
      auth: 'jwtOnly',
      requiredScopes: [ApiKeyScope.ADMIN],
    });
    await expect(call('DELETE', { id: VIEW_ID }, undefined, { ...ADMIN, isAdmin: false })).rejects.toThrow(
      'Admin access required'
    );
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('renames or shares the caller view', async () => {
    const res = await call('PATCH', { id: VIEW_ID }, { name: ' Renamed ', shared: true });
    expect(res._getStatusCode()).toBe(200);
    expect(mockUpdate).toHaveBeenCalledWith(ADMIN.id, VIEW_ID, { name: 'Renamed', shared: true }, {});
  });

  it('rejects an empty or unknown patch', async () => {
    await expect(call('PATCH', { id: VIEW_ID }, {})).rejects.toMatchObject({ statusCode: 400 });
    await expect(call('PATCH', { id: VIEW_ID }, { ownerId: 'b'.repeat(24) })).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('answers 404, not 400, for an id that is not an ObjectId', async () => {
    await expect(call('PATCH', { id: 'nope' }, { name: 'x' })).rejects.toMatchObject({ statusCode: 404 });
    await expect(call('DELETE', { id: 'nope' })).rejects.toMatchObject({ statusCode: 404 });
  });

  it('deletes the caller view', async () => {
    const res = await call('DELETE', { id: VIEW_ID });
    expect(res._getStatusCode()).toBe(204);
    expect(mockDelete).toHaveBeenCalledWith(ADMIN.id, VIEW_ID, {});
  });
});
