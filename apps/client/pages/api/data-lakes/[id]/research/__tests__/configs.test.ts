import { describe, it, expect, vi, beforeEach } from 'vitest';
import { researchFeedFingerprint } from '@bike4mind/common';

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
vi.mock('@bike4mind/server-utils/middlewares/featureFlag', () => ({ requireFeatureEnabled: () => () => {} }));
vi.mock('@bike4mind/services', async importOriginal => ({
  dataLakeResearchService: {
    feedFingerprintLevers: (await importOriginal<typeof import('@bike4mind/services')>()).dataLakeResearchService
      .feedFingerprintLevers,
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

vi.mock('@bike4mind/server-utils/dataLakes/toAccessContext', () => ({
  toAccessContext: vi.fn(async () => ({ userId: 'user-1', isAdmin: false })),
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
    expect(json).toHaveBeenCalledWith({ data: [{ ...savedConfig, feedStatus: null }], pendingProposals: 7 });
    expect(h.countPendingByLakes).toHaveBeenCalledWith(['lake-oid-1']);
  });

  // countPendingByLakes omits a lake with nothing pending rather than zero-filling it.
  it('reports zero pending proposals for a lake the count omits', async () => {
    h.countPendingByLakes.mockResolvedValue({});
    const { res, json } = makeRes();
    await call(indexHandler, req('GET', { id: 'my-lake' }), res);
    expect(json).toHaveBeenCalledWith({ data: [{ ...savedConfig, feedStatus: null }], pendingProposals: 0 });
  });

  it('carries the schedule through on create and update', async () => {
    const { res } = makeRes();
    const schedule = { cadence: 'weekly', reviewBacklogLimit: 40 };

    await call(indexHandler, req('POST', { id: 'l' }, { name: 'n', query: 'q', ...schedule }), res);
    await call(byIdHandler, req('PUT', { id: 'l', configId: 'config-1' }, schedule), res);

    expect(h.createResearchConfig.mock.calls[0][3]).toMatchObject(schedule);
    expect(h.updateResearchConfig.mock.calls[0][4]).toMatchObject(schedule);
  });

  describe('source tiers', () => {
    const tiers = { reviewDomains: ['a.example'], unlistedSources: 'drop', blockedDomains: ['b.example'] };

    it('forwards the review list and unlistedSources on create and update', async () => {
      const { res } = makeRes();
      await call(indexHandler, req('POST', { id: 'l' }, { name: 'n', query: 'q', ...tiers }), res);
      await call(byIdHandler, req('PUT', { id: 'l', configId: 'config-1' }, tiers), res);
      expect(h.createResearchConfig.mock.calls[0][3]).toMatchObject(tiers);
      expect(h.updateResearchConfig.mock.calls[0][4]).toMatchObject(tiers);
    });

    it('round-trips trustedDomains, autoAdmitTrusted and maxAutoAdmits to the service', async () => {
      const auto = { trustedDomains: ['t.example'], autoAdmitTrusted: true, maxAutoAdmits: 4 };
      const { res } = makeRes();
      await call(indexHandler, req('POST', { id: 'l' }, { name: 'n', query: 'q', ...auto }), res);
      await call(byIdHandler, req('PUT', { id: 'l', configId: 'config-1' }, auto), res);
      expect(h.createResearchConfig.mock.calls[0][3]).toMatchObject(auto);
      expect(h.updateResearchConfig.mock.calls[0][4]).toMatchObject(auto);
    });

    it('returns the auto-admit levers on a listed configuration', async () => {
      const stored = { ...savedConfig, trustedDomains: ['t.example'], autoAdmitTrusted: true, maxAutoAdmits: 4 };
      h.listResearchConfigs.mockResolvedValue([stored]);
      const { res, json } = makeRes();
      await call(indexHandler, req('GET', { id: 'my-lake' }), res);
      expect(json).toHaveBeenCalledWith({ data: [{ ...stored, feedStatus: null }], pendingProposals: 7 });
    });

    it('rejects an auto-admit flag of the wrong type', async () => {
      const { res } = makeRes();
      await expect(
        call(indexHandler, req('POST', { id: 'l' }, { name: 'n', query: 'q', autoAdmitTrusted: 'yes' }), res)
      ).rejects.toThrow();
    });

    it('still accepts a legacy allowedDomains body from a tab opened before the tiers', async () => {
      const { res } = makeRes();
      await call(indexHandler, req('POST', { id: 'l' }, { name: 'n', query: 'q', allowedDomains: ['a.example'] }), res);
      await call(byIdHandler, req('PUT', { id: 'l', configId: 'config-1' }, { allowedDomains: ['a.example'] }), res);
      expect(h.createResearchConfig.mock.calls[0][3]).toMatchObject({ allowedDomains: ['a.example'] });
      expect(h.updateResearchConfig.mock.calls[0][4]).toMatchObject({ allowedDomains: ['a.example'] });
    });

    it('rejects an unknown unlistedSources value', async () => {
      const { res } = makeRes();
      await expect(
        call(indexHandler, req('POST', { id: 'l' }, { name: 'n', query: 'q', unlistedSources: 'maybe' }), res)
      ).rejects.toThrow();
    });

    it('returns the tier fields next to the derived legacy allowedDomains', async () => {
      const stored = {
        ...savedConfig,
        trustedDomains: [],
        reviewDomains: ['a.example'],
        unlistedSources: 'drop',
        allowedDomains: ['a.example'],
      };
      h.listResearchConfigs.mockResolvedValue([stored]);
      const { res, json } = makeRes();
      await call(indexHandler, req('GET', { id: 'my-lake' }), res);
      expect(json).toHaveBeenCalledWith({ data: [{ ...stored, feedStatus: null }], pendingProposals: 7 });
    });
  });

  describe('feed source', () => {
    const feed = { source: 'feed', feedUrl: 'https://example.com/feed.xml' };
    const feedLevers = {
      feedUrl: 'https://example.com/feed.xml',
      query: 'topic',
      minRelevance: 0.5,
      trustedDomains: [],
      reviewDomains: [],
      unlistedSources: 'review',
      allowedDomains: [],
    };
    const NEWEST = '2026-11-01T00:00:00.000Z';
    const withCursor = (fingerprint: string) => ({
      ...savedConfig,
      ...feedLevers,
      source: 'feed',
      feedCursor: {
        fingerprint,
        newestPublishedAt: new Date(NEWEST),
        seenKeys: ['example.com/secret-key'],
        retries: [{ key: 'example.com/retry', attempts: 1 }],
      },
    });
    const expected = (current: boolean) => ({
      ...savedConfig,
      ...feedLevers,
      source: 'feed',
      feedStatus: { newestPublishedAt: new Date(NEWEST), current },
    });

    it('forwards source and feedUrl on create and update', async () => {
      const { res } = makeRes();
      await call(indexHandler, req('POST', { id: 'l' }, { name: 'n', query: 'q', ...feed }), res);
      await call(byIdHandler, req('PUT', { id: 'l', configId: 'config-1' }, feed), res);
      expect(h.createResearchConfig.mock.calls[0][3]).toMatchObject(feed);
      expect(h.updateResearchConfig.mock.calls[0][4]).toMatchObject(feed);
    });

    it('rejects an unknown source and a non-string feed address', async () => {
      const { res } = makeRes();
      await expect(
        call(indexHandler, req('POST', { id: 'l' }, { name: 'n', query: 'q', source: 'rss' }), res)
      ).rejects.toThrow();
      await expect(
        call(indexHandler, req('POST', { id: 'l' }, { name: 'n', query: 'q', feedUrl: 5 }), res)
      ).rejects.toThrow();
    });

    it('accepts a null feed address, which is how a client clears it', async () => {
      const { res } = makeRes();
      await call(byIdHandler, req('PUT', { id: 'l', configId: 'config-1' }, { source: 'search', feedUrl: null }), res);
      expect(h.updateResearchConfig.mock.calls[0][4]).toMatchObject({ source: 'search', feedUrl: null });
    });

    it('reports feedStatus and never the cursor on the list, create and update responses', async () => {
      const fresh = withCursor(researchFeedFingerprint(feedLevers as never));
      h.listResearchConfigs.mockResolvedValue([fresh]);
      h.createResearchConfig.mockResolvedValue(fresh);
      h.updateResearchConfig.mockResolvedValue(fresh);

      const list = makeRes();
      await call(indexHandler, req('GET', { id: 'my-lake' }), list.res);
      const created = makeRes();
      await call(indexHandler, req('POST', { id: 'l' }, { name: 'n', query: 'q' }), created.res);
      const updated = makeRes();
      await call(byIdHandler, req('PUT', { id: 'l', configId: 'config-1' }, {}), updated.res);

      expect(list.json).toHaveBeenCalledWith({ data: [expected(true)], pendingProposals: 7 });
      expect(created.json).toHaveBeenCalledWith({ data: expected(true) });
      expect(updated.json).toHaveBeenCalledWith({ data: expected(true) });
    });

    it('fingerprints the normalized levers, so an untrimmed query or unsorted domain list still matches', async () => {
      const written = { ...feedLevers, trustedDomains: ['a.com', 'b.com'] };
      const stored = {
        ...withCursor(researchFeedFingerprint(written as never)),
        query: '  topic ',
        trustedDomains: ['B.com', 'a.com'],
      };
      h.listResearchConfigs.mockResolvedValue([stored]);
      const { res, json } = makeRes();
      await call(indexHandler, req('GET', { id: 'my-lake' }), res);
      expect(json.mock.calls[0][0].data[0].feedStatus).toEqual({ newestPublishedAt: new Date(NEWEST), current: true });
    });

    it('reports a cursor written under other levers as not current', async () => {
      h.listResearchConfigs.mockResolvedValue([withCursor('written-under-old-levers')]);
      const { res, json } = makeRes();
      await call(indexHandler, req('GET', { id: 'my-lake' }), res);
      expect(json).toHaveBeenCalledWith({ data: [expected(false)], pendingProposals: 7 });
    });

    it('reports a null feedStatus for a config with no cursor', async () => {
      h.listResearchConfigs.mockResolvedValue([{ ...savedConfig, ...feedLevers, source: 'feed', feedCursor: null }]);
      const { res, json } = makeRes();
      await call(indexHandler, req('GET', { id: 'my-lake' }), res);
      expect(json.mock.calls[0][0].data[0].feedStatus).toBeNull();
      expect(json.mock.calls[0][0].data[0]).not.toHaveProperty('feedCursor');
    });
  });

  it('strips undeclared fields from each listed configuration, keeping pendingProposals', async () => {
    h.listResearchConfigs.mockResolvedValue([{ ...savedConfig, _id: 'raw-object-id', __v: 7, notInSchema: 'secret' }]);
    const { res, json } = makeRes();
    await call(indexHandler, req('GET', { id: 'my-lake' }), res);
    expect(json).toHaveBeenCalledWith({ data: [{ ...savedConfig, feedStatus: null }], pendingProposals: 7 });
  });

  it('strips undeclared fields from the created configuration', async () => {
    h.createResearchConfig.mockResolvedValue({ ...savedConfig, _id: 'raw-object-id', __v: 7, notInSchema: 'secret' });
    const { res, json } = makeRes();
    await call(indexHandler, req('POST', { id: 'l' }, { name: 'n', query: 'q' }), res);
    expect(res.status).toHaveBeenCalledWith(201);
    expect(json).toHaveBeenCalledWith({ data: { ...savedConfig, feedStatus: null } });
  });

  it('strips undeclared fields from the updated configuration', async () => {
    h.updateResearchConfig.mockResolvedValue({ ...savedConfig, _id: 'raw-object-id', __v: 7, notInSchema: 'secret' });
    const { res, json } = makeRes();
    await call(byIdHandler, req('PUT', { id: 'l', configId: 'config-1' }, { name: 'Weekly sweep' }), res);
    expect(json).toHaveBeenCalledWith({ data: { ...savedConfig, feedStatus: null } });
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
