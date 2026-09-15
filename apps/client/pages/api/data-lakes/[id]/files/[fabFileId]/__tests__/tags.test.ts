import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  assertLakeAccess: vi.fn(),
  assertLakeWritable: vi.fn(),
  setDataLakeFileTags: vi.fn(),
  toAccessContext: vi.fn(async () => ({ userId: 'u1', isAdmin: false })),
}));

// baseApi mock: callable chain routed by req.method, defaulting to PUT (this route has only one
// method) - the existing sibling chain (`[fabFileId].test.ts`) registers only `use`/`delete`/`post`.
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const routes: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign((req: { method?: string }, res: unknown) => routes[req.method ?? 'PUT']?.(req, res), {
      use: () => chain,
      put: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((routes.PUT = fns[fns.length - 1]), chain),
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
  fabFileRepository: {},
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
});
