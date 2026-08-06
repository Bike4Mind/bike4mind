import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Route-layer coverage for PUT/DELETE /api/files/tags/[id]. The service decides HOW to keep a
 * tag rename or delete in step with the names stored on files; the route decides WHETHER it can
 * at all, by putting a fabFiles repository in scope. That was the actual defect - the service had
 * no fabFiles adapter to reach, so no service-level test could have caught it.
 */

const h = vi.hoisted(() => ({
  update: vi.fn().mockResolvedValue({ id: 't1' }),
  remove: vi.fn().mockResolvedValue({ id: 't1', name: 'invoices', filesUpdated: 2 }),
}));

// baseApi mock: callable chain routed by req.method (same shape as the sibling toggle test).
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const routes: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign((req: { method?: string }, res: unknown) => routes[req.method ?? 'PUT']?.(req, res), {
      use: () => chain,
      put: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((routes.PUT = fns[fns.length - 1]), chain),
      delete: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((routes.DELETE = fns[fns.length - 1]), chain),
    });
    return chain;
  },
}));
vi.mock('@server/middlewares/asyncHandler', () => ({
  asyncHandler: (fn: (req: unknown, res: unknown) => unknown) => fn,
}));
vi.mock('@bike4mind/services', () => ({
  tagService: { update: h.update, remove: h.remove },
}));
vi.mock('@bike4mind/database', () => ({
  fabFileRepository: { __repo: 'fabFiles' },
  fileTagRepository: { __repo: 'fileTags' },
}));

import handler from '../[id]';

const makeRes = () => {
  const json = vi.fn();
  return { res: { json, status: vi.fn(() => ({ json })) } as never, json };
};
const call = (r: unknown, res: unknown) => (handler as (req: unknown, res: unknown) => Promise<void>)(r, res);

describe('PUT /api/files/tags/[id]', () => {
  beforeEach(() => vi.clearAllMocks());

  it('puts a fabFiles repository in scope so a rename can retag the files', async () => {
    const { res } = makeRes();

    await call({ method: 'PUT', query: { id: 't1' }, body: { id: 't1', name: 'receipts' }, user: { id: 'u1' } }, res);

    const [, , adapters] = h.update.mock.calls[0];
    expect(adapters.db.fabFiles).toEqual({ __repo: 'fabFiles' });
    expect(adapters.db.tags).toEqual({ __repo: 'fileTags' });
  });

  it('acts as the authenticated user, never a userId supplied in the body', async () => {
    const { res } = makeRes();

    await call(
      {
        method: 'PUT',
        query: { id: 't1' },
        body: { id: 't1', name: 'receipts', userId: 'someone-else' },
        user: { id: 'u1' },
      },
      res
    );

    const [actorId] = h.update.mock.calls[0];
    expect(actorId).toBe('u1');
  });

  it('rejects an unauthenticated request before reaching the service', async () => {
    const { res } = makeRes();

    await expect(call({ method: 'PUT', query: { id: 't1' }, body: {}, user: {} }, res)).rejects.toThrow('Unauthorized');
    expect(h.update).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/files/tags/[id]', () => {
  beforeEach(() => vi.clearAllMocks());

  it('puts a fabFiles repository in scope so the delete can untag the files', async () => {
    const { res } = makeRes();

    await call({ method: 'DELETE', query: { id: 't1' }, user: { id: 'u1' } }, res);

    const [, , adapters] = h.remove.mock.calls[0];
    expect(adapters.db.fabFiles).toEqual({ __repo: 'fabFiles' });
    expect(adapters.db.tags).toEqual({ __repo: 'fileTags' });
  });

  it('takes the tag id from the query string', async () => {
    const { res } = makeRes();

    await call({ method: 'DELETE', query: { id: 't1' }, user: { id: 'u1' } }, res);

    const [actorId, params] = h.remove.mock.calls[0];
    expect(actorId).toBe('u1');
    expect(params).toMatchObject({ id: 't1' });
  });

  it('rejects an unauthenticated request before reaching the service', async () => {
    const { res } = makeRes();

    await expect(call({ method: 'DELETE', query: { id: 't1' }, user: {} }, res)).rejects.toThrow('Unauthorized');
    expect(h.remove).not.toHaveBeenCalled();
  });
});
