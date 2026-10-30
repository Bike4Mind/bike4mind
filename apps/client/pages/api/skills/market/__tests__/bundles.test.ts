import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const h = vi.hoisted(() => ({
  listBundles: vi.fn(),
  createBundle: vi.fn(),
  updateBundle: vi.fn(),
  deleteBundle: vi.fn(),
}));

vi.mock('@client/server/middlewares/baseApi', () => ({
  baseApi: () => {
    const handlers: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const fn = (async (req: { method: string }, res: { status: (n: number) => { end: () => void } }) => {
      const handler = handlers[req.method];
      if (!handler) return res.status(405).end();
      return handler(req, res);
    }) as ((req: unknown, res: unknown) => unknown) & Record<string, (h: unknown) => unknown>;
    for (const method of ['get', 'post', 'put', 'delete']) {
      fn[method] = (h: unknown) => ((handlers[method.toUpperCase()] = h as never), fn);
    }
    return fn;
  },
}));
vi.mock('@server/skillMarket/bundles', () => h);

import indexHandler from '@pages/api/skills/market/bundles/index';
import idHandler from '@pages/api/skills/market/bundles/[id]';

const actor = { id: 'u1', isAdmin: true };
const call = async (
  handler: unknown,
  opts: { method: 'GET' | 'POST' | 'PUT' | 'DELETE'; query?: Record<string, string>; body?: object }
) => {
  const { req, res } = createMocks(opts as never);
  (req as unknown as { user: typeof actor }).user = actor;
  let error: unknown = null;
  try {
    await (handler as (a: unknown, b: unknown) => Promise<unknown>)(req, res);
  } catch (e) {
    error = e;
  }
  return { res, error };
};

beforeEach(() => vi.clearAllMocks());

describe('/api/skills/market/bundles', () => {
  it('lists the bundles of the org in the query, for the caller', async () => {
    h.listBundles.mockResolvedValue({ bundles: [], listings: [], canEdit: true });
    const { res } = await call(indexHandler, { method: 'GET', query: { orgId: 'org1' } });
    expect(h.listBundles).toHaveBeenCalledWith(actor, 'org1');
    expect(res._getJSONData()).toEqual({ bundles: [], listings: [], canEdit: true });
  });

  it('400s a list without an orgId', async () => {
    const { error } = await call(indexHandler, { method: 'GET' });
    expect(error).toMatchObject({ statusCode: 400 });
    expect(h.listBundles).not.toHaveBeenCalled();
  });

  it('creates with 201, passing the body and the caller through', async () => {
    h.createBundle.mockResolvedValue({ id: 'b1' });
    const body = { organizationId: 'org1', name: 'Pack' };
    const { res } = await call(indexHandler, { method: 'POST', body });
    expect(res._getStatusCode()).toBe(201);
    expect(h.createBundle).toHaveBeenCalledWith(actor, body);
  });
});

describe('/api/skills/market/bundles/[id]', () => {
  it('edits the bundle in the query', async () => {
    h.updateBundle.mockResolvedValue({ id: 'b1' });
    const { res } = await call(idHandler, { method: 'PUT', query: { id: 'b1' }, body: { name: 'x' } });
    expect(h.updateBundle).toHaveBeenCalledWith(actor, 'b1', { name: 'x' });
    expect(res._getJSONData()).toEqual({ id: 'b1' });
  });

  it('deletes with 204', async () => {
    h.deleteBundle.mockResolvedValue(undefined);
    const { res } = await call(idHandler, { method: 'DELETE', query: { id: 'b1' } });
    expect(res._getStatusCode()).toBe(204);
    expect(h.deleteBundle).toHaveBeenCalledWith(actor, 'b1');
  });
});
