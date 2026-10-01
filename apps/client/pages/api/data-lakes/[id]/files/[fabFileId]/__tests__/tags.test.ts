import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  assertLakeAccess: vi.fn(),
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
  dataLakeRepository: {},
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
    // The route accepts an id OR a slug and assertLakeAccess resolves it, so the service must
    // get lake.id - handing it the raw query value would address the wrong lake for a slug.
    h.assertLakeAccess.mockResolvedValue({ id: 'lake-oid-1', slug: 'my-lake' });
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

  it('wires the manage/admission settings repositories, and NOT a removal-record repository', async () => {
    h.assertLakeAccess.mockResolvedValue({ id: 'lake-oid-1', slug: 'my-lake' });
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
    h.assertLakeAccess.mockRejectedValue(new Error('Data lake not found'));
    const { res } = makeRes();

    await expect(call(req('PUT', { id: 'lake1', fabFileId: 'f1' }, { tags: ['lk:x'] }), res)).rejects.toThrow(
      /not found/i
    );
    expect(h.setDataLakeFileTags).not.toHaveBeenCalled();
  });

  it('does not set anything on a built-in read-only lake', async () => {
    h.assertLakeAccess.mockResolvedValue({ id: 'opti-knowledge', slug: 'opti' });
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
    h.assertLakeAccess.mockResolvedValue({ id: 'lake1' });
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
    h.assertLakeAccess.mockResolvedValue({ id: 'lake1' });
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
    h.assertLakeAccess.mockResolvedValue({ id: 'lake1' });
    const { res } = makeRes();

    await expect(call(req('PUT', { id: 'lake1', fabFileId: 'f1' }, {}), res)).rejects.toThrow();
    expect(h.setDataLakeFileTags).not.toHaveBeenCalled();
  });

  it('does not let a read-only API key through the PUT path', async () => {
    // The route's baseApi gate is read-scoped so the GET can serve readers; the PUT must assert
    // `datalake:write` itself or a read key would reach the write door.
    h.assertLakeAccess.mockResolvedValue({ id: 'lake1' });
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
});

describe('GET /api/data-lakes/[id]/files/[fabFileId]/tags', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
