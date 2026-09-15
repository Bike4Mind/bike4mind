import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  assertLakeResearchManage: vi.fn(),
  listResearchConfigs: vi.fn(),
  createResearchConfig: vi.fn(),
  updateResearchConfig: vi.fn(),
  deleteResearchConfig: vi.fn(),
}));

// baseApi mock: callable chain routed by req.method (same shape as sibling endpoint tests).
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const routes: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign((req: { method?: string }, res: unknown) => routes[req.method ?? 'GET']?.(req, res), {
      use: () => chain,
      get: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((routes.GET = fns[fns.length - 1]), chain),
      post: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((routes.POST = fns[fns.length - 1]), chain),
      put: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((routes.PUT = fns[fns.length - 1]), chain),
      delete: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((routes.DELETE = fns[fns.length - 1]), chain),
    });
    return chain;
  },
}));
vi.mock('@server/middlewares/featureFlag', () => ({ requireFeatureEnabled: () => () => {} }));
vi.mock('@bike4mind/services', () => ({
  dataLakeResearchService: {
    listResearchConfigs: h.listResearchConfigs,
    createResearchConfig: h.createResearchConfig,
    updateResearchConfig: h.updateResearchConfig,
    deleteResearchConfig: h.deleteResearchConfig,
  },
}));
vi.mock('@bike4mind/database', () => ({ dataLakeResearchConfigRepository: {} }));
vi.mock('@server/dataLakes/assertLakeResearchManage', () => ({
  assertLakeResearchManage: h.assertLakeResearchManage,
}));

import indexHandler from '../configs/index';
import byIdHandler from '../configs/[configId]';

const makeRes = () => {
  const json = vi.fn();
  const end = vi.fn();
  return { res: { json, end, status: vi.fn(() => ({ json, end })) } as never, json, end };
};

const req = (method: string, query: Record<string, string>, body?: unknown) =>
  ({ method, query, body, user: { id: 'user-1' } }) as never;

const call = (handler: unknown, r: unknown, res: unknown) =>
  (handler as (req: unknown, res: unknown) => Promise<void>)(r, res);

const savedConfig = { id: 'config-1', name: 'Weekly sweep' };

beforeEach(() => {
  vi.clearAllMocks();
  h.assertLakeResearchManage.mockResolvedValue({ id: 'lake-oid-1', name: 'Ops Lake' });
  h.listResearchConfigs.mockResolvedValue([savedConfig]);
  h.createResearchConfig.mockResolvedValue(savedConfig);
  h.updateResearchConfig.mockResolvedValue(savedConfig);
  h.deleteResearchConfig.mockResolvedValue(undefined);
});

describe('/api/data-lakes/[id]/research/configs', () => {
  it('lists a lake configurations for a manager', async () => {
    const { res, json } = makeRes();
    await call(indexHandler, req('GET', { id: 'my-lake' }), res);
    expect(json).toHaveBeenCalledWith({ data: [savedConfig] });
  });

  it('creates against the RESOLVED lake, not the raw id-or-slug from the URL', async () => {
    const { res } = makeRes();

    await call(indexHandler, req('POST', { id: 'my-lake' }, { name: 'Weekly', query: 'erosion' }), res);

    expect(h.createResearchConfig).toHaveBeenCalledWith(
      'lake-oid-1',
      'user-1',
      expect.objectContaining({ name: 'Weekly', query: 'erosion' }),
      expect.anything()
    );
  });

  it('answers 201 on create', async () => {
    const { res } = makeRes();
    await call(indexHandler, req('POST', { id: 'l' }, { name: 'n', query: 'q' }), res);
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it('carries a nulled recency window through, so a client can clear it', async () => {
    const { res } = makeRes();

    await call(byIdHandler, req('PUT', { id: 'l', configId: 'config-1' }, { recencyDays: null }), res);

    expect(h.updateResearchConfig).toHaveBeenCalledWith(
      'config-1',
      'lake-oid-1',
      'user-1',
      expect.objectContaining({ recencyDays: null }),
      expect.anything()
    );
  });

  // The panel's Default option has value '', and `draftToInput` sends `model: null` for it - so a
  // null judge model is what EVERY new configuration is saved with unless someone picks one. Both
  // verbs, because both extend the same lever object and a schema that rejects null breaks both.
  it('carries a null judge model through on create, the way the form sends the Default option', async () => {
    const { res } = makeRes();

    await call(indexHandler, req('POST', { id: 'l' }, { name: 'n', query: 'q', model: null }), res);

    expect(h.createResearchConfig).toHaveBeenCalledWith(
      'lake-oid-1',
      'user-1',
      expect.objectContaining({ model: null }),
      expect.anything()
    );
  });

  it('carries a null judge model through on update', async () => {
    const { res } = makeRes();

    await call(byIdHandler, req('PUT', { id: 'l', configId: 'config-1' }, { model: null }), res);

    expect(h.updateResearchConfig).toHaveBeenCalledWith(
      'config-1',
      'lake-oid-1',
      'user-1',
      expect.objectContaining({ model: null }),
      expect.anything()
    );
  });

  it('carries a chosen judge model through on create', async () => {
    const { res } = makeRes();

    await call(indexHandler, req('POST', { id: 'l' }, { name: 'n', query: 'q', model: 'gpt-4.1-mini' }), res);

    expect(h.createResearchConfig).toHaveBeenCalledWith(
      'lake-oid-1',
      'user-1',
      expect.objectContaining({ model: 'gpt-4.1-mini' }),
      expect.anything()
    );
  });

  // Ranges are the service's job (it clamps). What the route owes is type safety at the boundary.
  it('refuses a lever of the wrong type rather than passing it to the service', async () => {
    const { res } = makeRes();

    await expect(
      call(indexHandler, req('POST', { id: 'l' }, { name: 'n', query: 'q', maxResults: 'ten' }), res)
    ).rejects.toThrow();
    expect(h.createResearchConfig).not.toHaveBeenCalled();
  });

  it('accepts an out-of-range lever, leaving the clamp to the service', async () => {
    const { res } = makeRes();
    await call(indexHandler, req('POST', { id: 'l' }, { name: 'n', query: 'q', maxResults: 9_999 }), res);
    expect(h.createResearchConfig).toHaveBeenCalled();
  });

  it('deletes through the lake, and answers 204', async () => {
    const { res } = makeRes();

    await call(byIdHandler, req('DELETE', { id: 'l', configId: 'config-1' }), res);

    expect(h.deleteResearchConfig).toHaveBeenCalledWith('config-1', 'lake-oid-1', expect.anything());
    expect(res.status).toHaveBeenCalledWith(204);
  });

  describe('gates', () => {
    // Every verb, because a gate applied to three of four is the one that gets found.
    it.each([
      ['GET', () => call(indexHandler, req('GET', { id: 'l' }), makeRes().res)],
      ['POST', () => call(indexHandler, req('POST', { id: 'l' }, { name: 'n', query: 'q' }), makeRes().res)],
      ['PUT', () => call(byIdHandler, req('PUT', { id: 'l', configId: 'c' }, {}), makeRes().res)],
      ['DELETE', () => call(byIdHandler, req('DELETE', { id: 'l', configId: 'c' }), makeRes().res)],
    ])('propagates the manage refusal on %s', async (_verb, invoke) => {
      h.assertLakeResearchManage.mockRejectedValue(new Error('You do not have permission to manage research runs'));

      await expect(invoke()).rejects.toThrow(/permission to manage/i);
      expect(h.listResearchConfigs).not.toHaveBeenCalled();
      expect(h.createResearchConfig).not.toHaveBeenCalled();
      expect(h.updateResearchConfig).not.toHaveBeenCalled();
      expect(h.deleteResearchConfig).not.toHaveBeenCalled();
    });

    it('gates BEFORE parsing the body, so a stranger cannot probe the schema', async () => {
      h.assertLakeResearchManage.mockRejectedValue(new Error('Data lake not found'));
      const { res } = makeRes();

      await expect(call(indexHandler, req('POST', { id: 'l' }, { nonsense: true }), res)).rejects.toThrow(/not found/i);
    });
  });
});
