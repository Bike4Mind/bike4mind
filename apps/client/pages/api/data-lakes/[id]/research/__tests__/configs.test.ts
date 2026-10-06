import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  // Order log: 'enter'/'exit' bracket the transaction, other entries are pushed by the stubs inside it.
  tx: [] as string[],
  touchIfStable: vi.fn(),
  assertLakeResearchManage: vi.fn(),
  listResearchConfigs: vi.fn(),
  createResearchConfig: vi.fn(),
  updateResearchConfig: vi.fn(),
  deleteResearchConfig: vi.fn(),
  countPendingByLakes: vi.fn(),
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
vi.mock('@bike4mind/database', () => ({
  withTransaction: async (fn: () => unknown) => {
    h.tx.push('enter');
    try {
      return await fn();
    } finally {
      h.tx.push('exit');
    }
  },
  dataLakeRepository: { touchIfStable: h.touchIfStable },
  dataLakeResearchConfigRepository: {},
  dataLakeProposalRepository: { countPendingByLakes: h.countPendingByLakes },
  lakeConfigChangeEventRepository: {},
  adminSettingsRepository: {},
}));
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
const LAKE = { id: 'lake-oid-1', name: 'Ops Lake' };
const ACTOR = { userId: 'user-1', isAdmin: false, administeredOrgIds: [] };
const GRANTS: unknown[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  h.tx.length = 0;
  h.assertLakeResearchManage.mockResolvedValue({ lake: LAKE, actor: ACTOR, grants: GRANTS });
  h.listResearchConfigs.mockResolvedValue([savedConfig]);
  h.createResearchConfig.mockResolvedValue(savedConfig);
  h.updateResearchConfig.mockResolvedValue(savedConfig);
  h.deleteResearchConfig.mockResolvedValue(undefined);
  h.countPendingByLakes.mockResolvedValue({ 'lake-oid-1': 7 });
});

describe('/api/data-lakes/[id]/research/configs', () => {
  it('lists a lake configurations for a manager', async () => {
    const { res, json } = makeRes();
    await call(indexHandler, req('GET', { id: 'my-lake' }), res);
    expect(json).toHaveBeenCalledWith({ data: [savedConfig], pendingProposals: 7 });
    expect(h.countPendingByLakes).toHaveBeenCalledWith(['lake-oid-1']);
  });

  // countPendingByLakes omits a lake with nothing pending rather than zero-filling it.
  it('reports zero pending proposals for a lake the count omits', async () => {
    h.countPendingByLakes.mockResolvedValue({});
    const { res, json } = makeRes();
    await call(indexHandler, req('GET', { id: 'my-lake' }), res);
    expect(json).toHaveBeenCalledWith({ data: [savedConfig], pendingProposals: 0 });
  });

  it('carries the schedule through on create and update', async () => {
    const { res } = makeRes();
    const schedule = { cadence: 'weekly', reviewBacklogLimit: 40 };

    await call(indexHandler, req('POST', { id: 'l' }, { name: 'n', query: 'q', ...schedule }), res);
    await call(byIdHandler, req('PUT', { id: 'l', configId: 'config-1' }, schedule), res);

    expect(h.createResearchConfig.mock.calls[0][3]).toMatchObject(schedule);
    expect(h.updateResearchConfig.mock.calls[0][4]).toMatchObject(schedule);
  });

  it('refuses a cadence the scheduler does not know', async () => {
    const { res } = makeRes();
    await expect(
      call(indexHandler, req('POST', { id: 'l' }, { name: 'n', query: 'q', cadence: 'hourly' }), res)
    ).rejects.toThrow();
    expect(h.createResearchConfig).not.toHaveBeenCalled();
  });

  it('creates against the RESOLVED lake, not the raw id-or-slug from the URL', async () => {
    const { res } = makeRes();

    await call(indexHandler, req('POST', { id: 'my-lake' }, { name: 'Weekly', query: 'erosion' }), res);

    expect(h.createResearchConfig).toHaveBeenCalledWith(
      LAKE,
      ACTOR,
      GRANTS,
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
      LAKE,
      ACTOR,
      GRANTS,
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
      LAKE,
      ACTOR,
      GRANTS,
      expect.objectContaining({ model: null }),
      expect.anything()
    );
  });

  it('carries a null judge model through on update', async () => {
    const { res } = makeRes();

    await call(byIdHandler, req('PUT', { id: 'l', configId: 'config-1' }, { model: null }), res);

    expect(h.updateResearchConfig).toHaveBeenCalledWith(
      'config-1',
      LAKE,
      ACTOR,
      GRANTS,
      expect.objectContaining({ model: null }),
      expect.anything()
    );
  });

  it('carries a chosen judge model through on create', async () => {
    const { res } = makeRes();

    await call(indexHandler, req('POST', { id: 'l' }, { name: 'n', query: 'q', model: 'gpt-4.1-mini' }), res);

    expect(h.createResearchConfig).toHaveBeenCalledWith(
      LAKE,
      ACTOR,
      GRANTS,
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

    expect(h.deleteResearchConfig).toHaveBeenCalledWith('config-1', LAKE, ACTOR, GRANTS, expect.anything());
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

  it.each([
    [
      'create',
      'createResearchConfig',
      () => call(indexHandler, req('POST', { id: 'l' }, { name: 'n' }), makeRes().res),
    ],
    [
      'update',
      'updateResearchConfig',
      () => call(byIdHandler, req('PUT', { id: 'l', configId: 'c1' }, {}), makeRes().res),
    ],
    [
      'delete',
      'deleteResearchConfig',
      () => call(byIdHandler, req('DELETE', { id: 'l', configId: 'c1' }), makeRes().res),
    ],
  ] as const)(
    '%s: runs the manage gate and the write inside one transaction, then touches the resolved lake last',
    async (_label, writeFn, invoke) => {
      h.assertLakeResearchManage.mockImplementation(async () => {
        h.tx.push('gate');
        return { lake: LAKE, actor: ACTOR, grants: GRANTS };
      });
      h[writeFn].mockImplementation(async () => {
        h.tx.push('write');
        return savedConfig;
      });
      h.touchIfStable.mockImplementation(async () => {
        h.tx.push('touch');
        return true;
      });

      await invoke();

      expect(h.tx).toEqual(['enter', 'gate', 'write', 'touch', 'exit']);
      expect(h.touchIfStable).toHaveBeenCalledWith('lake-oid-1');
    }
  );

  it.each([
    [
      'create',
      'createResearchConfig',
      () => call(indexHandler, req('POST', { id: 'l' }, { name: 'n' }), makeRes().res),
    ],
    [
      'update',
      'updateResearchConfig',
      () => call(byIdHandler, req('PUT', { id: 'l', configId: 'c1' }, {}), makeRes().res),
    ],
    [
      'delete',
      'deleteResearchConfig',
      () => call(byIdHandler, req('DELETE', { id: 'l', configId: 'c1' }), makeRes().res),
    ],
  ] as const)('%s: neither writes nor touches when the manage gate throws', async (_label, writeFn, invoke) => {
    h.assertLakeResearchManage.mockRejectedValue(new Error('forbidden'));

    await expect(invoke()).rejects.toThrow('forbidden');
    expect(h[writeFn]).not.toHaveBeenCalled();
    expect(h.touchIfStable).not.toHaveBeenCalled();
  });
});
