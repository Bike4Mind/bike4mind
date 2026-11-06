import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ApiKeyScope } from '@bike4mind/common';

const { mockFindById } = vi.hoisted(() => ({ mockFindById: vi.fn() }));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (config?: unknown) => {
    const h: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const middlewares: Array<(req: unknown, res: unknown, next: () => void) => void> = [];
    const chain = Object.assign(
      async (req: unknown, res: unknown) => {
        for (const middleware of middlewares) middleware(req, res, () => undefined);
        return h[(req as { method?: string }).method ?? 'GET']?.(req, res);
      },
      {
        use: (fn: (req: unknown, res: unknown, next: () => void) => void) => (middlewares.push(fn), chain),
        get: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((h.GET = fns[fns.length - 1]), chain),
        _config: config,
      }
    );
    return chain;
  },
}));
vi.mock('@bike4mind/database', () => ({
  adminAuditLogRepository: { findById: (...a: unknown[]) => mockFindById(...a) },
}));

import handler from '../[id]';

const call = (query: Record<string, string | string[]> = {}, user: unknown = { id: 'admin1', isAdmin: true }) => {
  const { req, res } = createMocks({ method: 'GET', query });
  if (user) (req as Record<string, unknown>).user = user;
  return { req, res, promise: (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res) };
};

const scopesOf = () => (handler as unknown as { _config?: { requiredScopes?: string[] } })._config?.requiredScopes;

beforeEach(() => {
  mockFindById.mockReset().mockResolvedValue(null);
});

describe('GET /api/admin/audit-log/:id', () => {
  it('declares requiredScopes [ApiKeyScope.ADMIN]', () => {
    expect(scopesOf()).toEqual([ApiKeyScope.ADMIN]);
  });

  it('rejects a non-admin with 403', async () => {
    const { promise } = call({}, { id: 'u2', isAdmin: false });
    await expect(promise).rejects.toMatchObject({ statusCode: 403 });
  });

  it('returns 404 for a non-ObjectId id', async () => {
    await expect(call({ id: 'not-an-id' }).promise).rejects.toMatchObject({ statusCode: 404 });
    expect(mockFindById).toHaveBeenCalledWith('not-an-id');
  });

  it('returns the entry', async () => {
    mockFindById.mockResolvedValue({ id: 'a'.repeat(24), action: 'audit.exported' });
    const { res, promise } = call({ id: 'a'.repeat(24) });
    await promise;

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toMatchObject({ action: 'audit.exported' });
  });
});
