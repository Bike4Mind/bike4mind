import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  // Order log: 'enter'/'exit' bracket the transaction, other entries are pushed by the stubs inside it.
  tx: [] as string[],
  touchIfStable: vi.fn(),
  assertLakeAccess: vi.fn(),
  assertLakeAccessById: vi.fn(),
  assertLakeWritable: vi.fn(),
  setDataLakeFileTags: vi.fn(),
  resolveCanManageLake: vi.fn(),
  decideStampPrefix: vi.fn(),
  stampRefusalMessage: vi.fn(),
  UNVERIFIED_PREFIX_OVERLAP_REFUSAL: 'Could not verify this data lake tag prefix right now - try again',
  lakeMembershipSignals: vi.fn(),
  fabFileFindById: vi.fn(),
  toAccessContext: vi.fn(async () => ({ userId: 'u1', isAdmin: false })),
}));

// baseApi mock: callable chain routed by req.method, defaulting to PUT. Registers both methods this
// route now serves (PUT tags, GET current tags).
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const routes: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign((req: { method?: string }, res: unknown) => routes[req.method ?? 'PUT']?.(req, res), {
      use: () => chain,
      put: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((routes.PUT = fns[fns.length - 1]), chain),
      get: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((routes.GET = fns[fns.length - 1]), chain),
    });
    return chain;
  },
}));
vi.mock('@server/middlewares/featureFlag', () => ({ requireFeatureEnabled: () => () => {} }));
vi.mock('@bike4mind/services', () => ({
  dataLakeService: {
    assertLakeAccess: h.assertLakeAccess,
    assertLakeAccessById: h.assertLakeAccessById,
    assertLakeWritable: h.assertLakeWritable,
    setDataLakeFileTags: h.setDataLakeFileTags,
    resolveCanManageLake: h.resolveCanManageLake,
    decideStampPrefix: h.decideStampPrefix,
    stampRefusalMessage: h.stampRefusalMessage,
    UNVERIFIED_PREFIX_OVERLAP_REFUSAL: h.UNVERIFIED_PREFIX_OVERLAP_REFUSAL,
    lakeMembershipSignals: h.lakeMembershipSignals,
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
  dataLakeAccessGrantRepository: {
    listByLake: vi.fn().mockResolvedValue([]),
    listActiveByLakes: vi.fn().mockResolvedValue([]),
    listByPrincipal: vi.fn().mockResolvedValue([]),
    findGrant: vi.fn().mockResolvedValue(null),
    upsertGrant: vi.fn().mockResolvedValue({}),
    removeGrant: vi.fn().mockResolvedValue(true),
    removeAllForLake: vi.fn().mockResolvedValue(0),
  },
  fabFileRepository: { findById: h.fabFileFindById },
  userRepository: {},
  lakeConfigChangeEventRepository: { record: vi.fn() },
  adminSettingsRepository: { findBySettingNames: vi.fn(), findAll: vi.fn() },
  scopedSettingsRepository: { findOverrides: vi.fn().mockResolvedValue([]) },
}));
vi.mock('@server/dataLakes/toAccessContext', () => ({ toAccessContext: h.toAccessContext }));

import handler from '../tags';

const makeRes = () => {
  const json = vi.fn();
  return { res: { json, status: vi.fn(() => ({ json })) } as never, json };
};
const req = (method: string, query: Record<string, string>, body: unknown = undefined) =>
  ({ method, query, body }) as never;
const call = (r: unknown, res: unknown) => (handler as (req: unknown, res: unknown) => Promise<void>)(r, res);

describe('PUT /api/data-lakes/[id]/files/[fabFileId]/tags', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.tx.length = 0;
    h.toAccessContext.mockResolvedValue({ userId: 'u1', isAdmin: false });
    h.assertLakeWritable.mockReturnValue(undefined);
    h.setDataLakeFileTags.mockResolvedValue({
      success: true,
      fileCount: 2,
      totalSizeBytes: 30,
      tags: { added: ['lk:x'], removed: [], retained: [], current: ['lk:x'] },
    });
  });

  it('sets tags against the RESOLVED lake and returns the service result verbatim', async () => {
    // The service must get the gate's resolved lake.id, never the raw query value (which differs
    // here on purpose, so forwarding the query instead would fail this test).
    h.assertLakeAccessById.mockResolvedValue({ id: 'lake-oid-1', slug: 'my-lake' });
    const { res, json } = makeRes();

    await call(req('PUT', { id: 'my-lake', fabFileId: 'f1' }, { tags: ['lk:x'] }), res);

    expect(h.setDataLakeFileTags).toHaveBeenCalledWith(
      { userId: 'u1', isAdmin: false },
      'lake-oid-1',
      'f1',
      ['lk:x'],
      expect.anything()
    );
    expect(json).toHaveBeenCalledWith({
      success: true,
      fileCount: 2,
      totalSizeBytes: 30,
      tags: { added: ['lk:x'], removed: [], retained: [], current: ['lk:x'] },
    });
  });

  // The write resolves by id only: a slug skips a deleted lake and would retag the file in the next
  // lake sharing it. The GET below still takes a slug.
  it('gates the write through the id-only gate, never the slug-tolerant one', async () => {
    h.assertLakeAccessById.mockResolvedValue({ id: 'lake1' });
    const { res } = makeRes();

    await call(req('PUT', { id: 'lake1', fabFileId: 'f1' }, { tags: ['lk:x'] }), res);

    expect(h.assertLakeAccessById).toHaveBeenCalledWith('lake1', expect.anything(), expect.anything());
    expect(h.assertLakeAccess).not.toHaveBeenCalled();
  });

  it('wires the manage/admission settings repositories, and NOT a removal-record repository', async () => {
    h.assertLakeAccessById.mockResolvedValue({ id: 'lake-oid-1', slug: 'my-lake' });
    const { res } = makeRes();

    await call(req('PUT', { id: 'my-lake', fabFileId: 'f1' }, { tags: ['lk:x'] }), res);

    const adapters = h.setDataLakeFileTags.mock.calls[0][4] as { db: Record<string, unknown> };
    expect(adapters.db.dataLakeAccessGrants).toBeDefined();
    expect(adapters.db.adminSettings).toBeDefined();
    expect(adapters.db.scopedSettings).toBeDefined();
    // This door writes no `LakeMembershipRemoval` and reads none - pins that the route does not
    // silently carry one in, the way the sibling POST/DELETE doors deliberately do.
    expect(adapters.db.lakeMembershipRemovals).toBeUndefined();
  });

  it('does not set anything when the access gate denies the lake', async () => {
    h.assertLakeAccessById.mockRejectedValue(new Error('Data lake not found'));
    const { res } = makeRes();

    await expect(call(req('PUT', { id: 'lake1', fabFileId: 'f1' }, { tags: ['lk:x'] }), res)).rejects.toThrow(
      /not found/i
    );
    expect(h.setDataLakeFileTags).not.toHaveBeenCalled();
  });

  it('does not set anything on a built-in read-only lake', async () => {
    h.assertLakeAccessById.mockResolvedValue({ id: 'opti-knowledge', slug: 'opti' });
    h.assertLakeWritable.mockImplementation(() => {
      throw new Error('This data lake is built into the platform and is read-only');
    });
    const { res } = makeRes();

    await expect(call(req('PUT', { id: 'opti', fabFileId: 'f1' }, { tags: ['lk:x'] }), res)).rejects.toThrow(
      /read-only/i
    );
    expect(h.setDataLakeFileTags).not.toHaveBeenCalled();
  });

  it('takes the actor from the access context, never from the request body', async () => {
    h.assertLakeAccessById.mockResolvedValue({ id: 'lake1' });
    const { res } = makeRes();

    await call(
      req('PUT', { id: 'lake1', fabFileId: 'f1' }, { tags: ['lk:x'], userId: 'attacker', isAdmin: true }),
      res
    );

    expect(h.setDataLakeFileTags).toHaveBeenCalledWith(
      { userId: 'u1', isAdmin: false },
      'lake1',
      'f1',
      ['lk:x'],
      expect.anything()
    );
  });

  it('parses the body and passes the parsed tags array as the 4th argument', async () => {
    h.assertLakeAccessById.mockResolvedValue({ id: 'lake1' });
    const { res } = makeRes();

    await call(req('PUT', { id: 'lake1', fabFileId: 'f1' }, { tags: ['lk:a', 'lk:b'] }), res);

    expect(h.setDataLakeFileTags).toHaveBeenCalledWith(
      expect.anything(),
      'lake1',
      'f1',
      ['lk:a', 'lk:b'],
      expect.anything()
    );
  });

  it('throws before calling the service on a malformed body (missing tags)', async () => {
    h.assertLakeAccessById.mockResolvedValue({ id: 'lake1' });
    const { res } = makeRes();

    await expect(call(req('PUT', { id: 'lake1', fabFileId: 'f1' }, {}), res)).rejects.toThrow();
    expect(h.setDataLakeFileTags).not.toHaveBeenCalled();
  });

  it('does not let a read-only API key through the PUT path', async () => {
    // The route's baseApi gate is read-scoped so the GET can serve readers; the PUT must assert
    // `datalake:write` itself or a read key would reach the write door.
    h.assertLakeAccessById.mockResolvedValue({ id: 'lake1' });
    const { res } = makeRes();
    const readOnly = {
      method: 'PUT',
      query: { id: 'lake1', fabFileId: 'f1' },
      body: {},
      apiKeyInfo: { scopes: ['datalake:read'] },
    };

    await expect(call(readOnly, res)).rejects.toThrow();
    expect(h.setDataLakeFileTags).not.toHaveBeenCalled();
  });

  it('runs the gate and the write inside one transaction, then touches the resolved lake last', async () => {
    h.assertLakeAccessById.mockImplementation(async () => {
      h.tx.push('gate');
      return { id: 'lake-oid-1', slug: 'my-lake' };
    });
    h.setDataLakeFileTags.mockImplementation(async () => {
      h.tx.push('write');
      return { success: true };
    });
    h.touchIfStable.mockImplementation(async () => {
      h.tx.push('touch');
      return true;
    });
    const { res } = makeRes();

    await call(req('PUT', { id: 'my-lake', fabFileId: 'f1' }, { tags: ['lk:x'] }), res);

    expect(h.tx).toEqual(['enter', 'gate', 'write', 'touch', 'exit']);
    expect(h.touchIfStable).toHaveBeenCalledWith('lake-oid-1');
  });

  it('neither writes nor touches when the gate throws', async () => {
    h.assertLakeAccessById.mockRejectedValue(new Error('Data lake not found'));
    const { res } = makeRes();

    await expect(call(req('PUT', { id: 'lake1', fabFileId: 'f1' }, { tags: ['lk:x'] }), res)).rejects.toThrow(
      /not found/i
    );
    expect(h.setDataLakeFileTags).not.toHaveBeenCalled();
    expect(h.touchIfStable).not.toHaveBeenCalled();
  });
});

describe('GET /api/data-lakes/[id]/files/[fabFileId]/tags', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.tx.length = 0;
    h.toAccessContext.mockResolvedValue({ userId: 'u1', isAdmin: false });
    h.assertLakeWritable.mockReturnValue(undefined);
    h.assertLakeAccess.mockResolvedValue({ id: 'lake-oid-1', slug: 'my-lake' });
    h.resolveCanManageLake.mockResolvedValue(true);
    h.decideStampPrefix.mockResolvedValue({ stamp: true, prefix: 'lk:' });
    h.stampRefusalMessage.mockReturnValue('This lake tag prefix cannot be used right now');
    h.lakeMembershipSignals.mockReturnValue({ inLake: true, tagsToPull: [], contentTags: [] });
    h.fabFileFindById.mockResolvedValue({
      id: 'f1',
      userId: 'u1',
      deletedAt: null,
      tags: [
        { name: 'lk:finance', strength: 1 },
        { name: 'lk:uncategorized', strength: 1 },
        { name: 'other:keep', strength: 1 },
      ],
    });
  });

  it('returns the lake prefix and only the names under it', async () => {
    const { res, json } = makeRes();

    await call(req('GET', { id: 'my-lake', fabFileId: 'f1' }), res);

    expect(json).toHaveBeenCalledWith({ prefix: 'lk:', current: ['lk:finance', 'lk:uncategorized'] });
  });

  it('gates on the MANAGE rung, not mere read access', async () => {
    h.resolveCanManageLake.mockResolvedValue(false);
    const { res } = makeRes();

    await expect(call(req('GET', { id: 'lake1', fabFileId: 'f1' }), res)).rejects.toThrow(/permission/i);
    expect(h.fabFileFindById).not.toHaveBeenCalled();
  });

  it('refuses a non-member file with a 404 rather than leaking it', async () => {
    h.lakeMembershipSignals.mockReturnValue({ inLake: false, tagsToPull: [], contentTags: [] });
    const { res } = makeRes();

    await expect(call(req('GET', { id: 'lake1', fabFileId: 'f1' }), res)).rejects.toThrow(/not found/i);
  });

  it('refuses when the lake cannot stamp its prefix', async () => {
    h.decideStampPrefix.mockResolvedValue({ stamp: false, reason: 'prefix-overlap' });
    const { res } = makeRes();

    await expect(call(req('GET', { id: 'lake1', fabFileId: 'f1' }), res)).rejects.toThrow();
    expect(h.fabFileFindById).not.toHaveBeenCalled();
  });

  it('refuses when the prefix overlap check could not be verified', async () => {
    // `stamp` can be true while the fail-closed overlap check failed - the write door refuses
    // there too, so the read must not seed a set the PUT would reject.
    h.decideStampPrefix.mockResolvedValue({ stamp: true, prefix: 'lk:', overlapCheckFailed: true });
    const { res } = makeRes();

    await expect(call(req('GET', { id: 'lake1', fabFileId: 'f1' }), res)).rejects.toThrow(
      /Could not verify this data lake tag prefix/i
    );
    expect(h.fabFileFindById).not.toHaveBeenCalled();
  });

  it('reads nothing when the access gate denies the lake', async () => {
    h.assertLakeAccess.mockRejectedValue(new Error('Data lake not found'));
    const { res } = makeRes();

    await expect(call(req('GET', { id: 'lake1', fabFileId: 'f1' }), res)).rejects.toThrow(/not found/i);
    expect(h.resolveCanManageLake).not.toHaveBeenCalled();
    expect(h.fabFileFindById).not.toHaveBeenCalled();
  });

  it('returns an empty current set when the file has no tags under the prefix', async () => {
    h.fabFileFindById.mockResolvedValue({
      id: 'f1',
      userId: 'u1',
      deletedAt: null,
      tags: [{ name: 'other:x', strength: 1 }],
    });
    const { res, json } = makeRes();

    await call(req('GET', { id: 'lake1', fabFileId: 'f1' }), res);

    expect(json).toHaveBeenCalledWith({ prefix: 'lk:', current: [] });
  });
});
