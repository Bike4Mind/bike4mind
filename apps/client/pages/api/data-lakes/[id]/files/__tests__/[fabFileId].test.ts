import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  assertLakeAccess: vi.fn(),
  assertLakeWritable: vi.fn(),
  removeFileFromDataLake: vi.fn(),
  addFileToDataLake: vi.fn(),
  toAccessContext: vi.fn(async () => ({ userId: 'u1', isAdmin: false })),
}));

// baseApi mock: callable chain routed by req.method (same shape as the lifecycle test).
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const routes: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign(
      (req: { method?: string }, res: unknown) => routes[req.method ?? 'DELETE']?.(req, res),
      {
        use: () => chain,
        delete: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((routes.DELETE = fns[fns.length - 1]), chain),
        post: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((routes.POST = fns[fns.length - 1]), chain),
      }
    );
    return chain;
  },
}));
vi.mock('@server/middlewares/featureFlag', () => ({ requireFeatureEnabled: () => () => {} }));
vi.mock('@bike4mind/services', () => ({
  dataLakeService: {
    assertLakeAccess: h.assertLakeAccess,
    assertLakeWritable: h.assertLakeWritable,
    removeFileFromDataLake: h.removeFileFromDataLake,
    addFileToDataLake: h.addFileToDataLake,
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
  lakeMembershipRemovalRepository: { upsertRemoval: vi.fn(), findLive: vi.fn().mockResolvedValue(null) },
  scopedSettingsRepository: { findOverrides: vi.fn().mockResolvedValue([]) },
}));
vi.mock('@server/dataLakes/toAccessContext', () => ({ toAccessContext: h.toAccessContext }));

import handler from '../[fabFileId]';

const makeRes = () => {
  const json = vi.fn();
  return { res: { json, status: vi.fn(() => ({ json })) } as never, json };
};
const req = (method: string, query: Record<string, string>, body: unknown = undefined) =>
  ({ method, query, body }) as never;
const call = (r: unknown, res: unknown) => (handler as (req: unknown, res: unknown) => Promise<void>)(r, res);

describe('DELETE /api/data-lakes/[id]/files/[fabFileId]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.toAccessContext.mockResolvedValue({ userId: 'u1', isAdmin: false });
    h.assertLakeWritable.mockReturnValue(undefined);
    h.removeFileFromDataLake.mockResolvedValue({ success: true, fileCount: 2, totalSizeBytes: 30 });
    h.addFileToDataLake.mockResolvedValue({ success: true, fileCount: 3, totalSizeBytes: 40 });
  });

  it('removes the file against the RESOLVED lake and returns the service result verbatim', async () => {
    // The route accepts an id OR a slug and assertLakeAccess resolves it, so the service must
    // get lake.id - handing it the raw query value would address the wrong lake for a slug.
    h.assertLakeAccess.mockResolvedValue({ id: 'lake-oid-1', slug: 'my-lake' });
    const { res, json } = makeRes();

    await call(req('DELETE', { id: 'my-lake', fabFileId: 'f1' }), res);

    expect(h.removeFileFromDataLake).toHaveBeenCalledWith(
      { userId: 'u1', isAdmin: false },
      'lake-oid-1',
      'f1',
      expect.anything()
    );
    expect(json).toHaveBeenCalledWith({ success: true, fileCount: 2, totalSizeBytes: 30 });
  });

  /**
   * The audit wiring, asserted HERE because a services test structurally cannot see it: the service
   * takes both repositories as OPTIONAL and `recordLakeConfigChange` returns early when they are
   * absent, so a route that forgets them records nothing and reports success. That is exactly what
   * this route did - it passed a `logger` with no event repo, so the draft -> active flip a removal
   * can trigger was silently unrecorded and the logger had nothing to report. The services test
   * passed throughout, because its own fixture supplied the repos the route did not.
   */
  it('wires the config-audit repositories, so a removal that activates the lake is actually recorded', async () => {
    h.assertLakeAccess.mockResolvedValue({ id: 'lake-oid-1', slug: 'my-lake' });
    const { res } = makeRes();

    await call(req('DELETE', { id: 'my-lake', fabFileId: 'f1' }), res);

    const adapters = h.removeFileFromDataLake.mock.calls[0][3] as {
      db: Record<string, unknown>;
      logger?: unknown;
    };
    expect(adapters.db.lakeConfigChangeEvents).toBeDefined();
    // adminSettings too: without it the retention lever is never read, so events land at the floor
    // default and the lever has no consumer on this path.
    expect(adapters.db.adminSettings).toBeDefined();
    // The restore record repository (#2248) - without it the removal writes no restore token and
    // the POST below can never find one.
    expect(adapters.db.lakeMembershipRemovals).toBeDefined();
  });

  it('does not remove anything when the access gate denies the lake', async () => {
    h.assertLakeAccess.mockRejectedValue(new Error('Data lake not found'));
    const { res } = makeRes();

    await expect(call(req('DELETE', { id: 'lake1', fabFileId: 'f1' }), res)).rejects.toThrow(/not found/i);
    expect(h.removeFileFromDataLake).not.toHaveBeenCalled();
  });

  it('does not remove anything from a built-in read-only lake', async () => {
    // assertLakeWritable is what keeps a registry lake's prefixed tags out of reach of the
    // removal write, so the file-tag clear can never touch curated shared content.
    h.assertLakeAccess.mockResolvedValue({ id: 'opti-knowledge', slug: 'opti' });
    h.assertLakeWritable.mockImplementation(() => {
      throw new Error('This data lake is built into the platform and is read-only');
    });
    const { res } = makeRes();

    await expect(call(req('DELETE', { id: 'opti', fabFileId: 'f1' }), res)).rejects.toThrow(/read-only/i);
    expect(h.removeFileFromDataLake).not.toHaveBeenCalled();
  });

  it('forwards an admin actor through to the service (untested before, so a route that hardcoded isAdmin: false would have gone unnoticed)', async () => {
    h.assertLakeAccess.mockResolvedValue({ id: 'lake1' });
    h.toAccessContext.mockResolvedValue({ userId: 'root', isAdmin: true });
    const { res } = makeRes();

    await call(req('DELETE', { id: 'lake1', fabFileId: 'f1' }), res);

    expect(h.removeFileFromDataLake).toHaveBeenCalledWith(
      { userId: 'root', isAdmin: true },
      'lake1',
      'f1',
      expect.anything()
    );
  });

  it('takes the actor from the access context, never from the request body', async () => {
    h.assertLakeAccess.mockResolvedValue({ id: 'lake1' });
    const { res } = makeRes();

    await call(req('DELETE', { id: 'lake1', fabFileId: 'f1' }, { userId: 'attacker', isAdmin: true }), res);

    expect(h.removeFileFromDataLake).toHaveBeenCalledWith(
      { userId: 'u1', isAdmin: false },
      'lake1',
      'f1',
      expect.anything()
    );
  });
});

describe('POST /api/data-lakes/[id]/files/[fabFileId]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.toAccessContext.mockResolvedValue({ userId: 'u1', isAdmin: false });
    h.assertLakeWritable.mockReturnValue(undefined);
    h.addFileToDataLake.mockResolvedValue({ success: true, fileCount: 3, totalSizeBytes: 40 });
  });

  it('adds the file against the RESOLVED lake and returns the service result verbatim', async () => {
    h.assertLakeAccess.mockResolvedValue({ id: 'lake-oid-1', slug: 'my-lake' });
    const { res, json } = makeRes();

    await call(req('POST', { id: 'my-lake', fabFileId: 'f1' }), res);

    expect(h.addFileToDataLake).toHaveBeenCalledWith(
      { userId: 'u1', isAdmin: false },
      'lake-oid-1',
      'f1',
      expect.anything()
    );
    expect(json).toHaveBeenCalledWith({ success: true, fileCount: 3, totalSizeBytes: 40 });
  });

  it('wires the removal-record repository and the admission-contract settings repositories', async () => {
    h.assertLakeAccess.mockResolvedValue({ id: 'lake-oid-1', slug: 'my-lake' });
    const { res } = makeRes();

    await call(req('POST', { id: 'my-lake', fabFileId: 'f1' }), res);

    const adapters = h.addFileToDataLake.mock.calls[0][3] as { db: Record<string, unknown> };
    expect(adapters.db.lakeMembershipRemovals).toBeDefined();
    expect(adapters.db.adminSettings).toBeDefined();
    expect(adapters.db.scopedSettings).toBeDefined();
  });

  it('does not add anything when the access gate denies the lake', async () => {
    h.assertLakeAccess.mockRejectedValue(new Error('Data lake not found'));
    const { res } = makeRes();

    await expect(call(req('POST', { id: 'lake1', fabFileId: 'f1' }), res)).rejects.toThrow(/not found/i);
    expect(h.addFileToDataLake).not.toHaveBeenCalled();
  });

  it('does not add anything to a built-in read-only lake', async () => {
    h.assertLakeAccess.mockResolvedValue({ id: 'opti-knowledge', slug: 'opti' });
    h.assertLakeWritable.mockImplementation(() => {
      throw new Error('This data lake is built into the platform and is read-only');
    });
    const { res } = makeRes();

    await expect(call(req('POST', { id: 'opti', fabFileId: 'f1' }), res)).rejects.toThrow(/read-only/i);
    expect(h.addFileToDataLake).not.toHaveBeenCalled();
  });

  it('takes the actor from the access context, never from the request body', async () => {
    h.assertLakeAccess.mockResolvedValue({ id: 'lake1' });
    const { res } = makeRes();

    await call(req('POST', { id: 'lake1', fabFileId: 'f1' }, { userId: 'attacker', isAdmin: true }), res);

    expect(h.addFileToDataLake).toHaveBeenCalledWith(
      { userId: 'u1', isAdmin: false },
      'lake1',
      'f1',
      expect.anything()
    );
  });

  // The whole point of #2248's Key Decision 2: the restore tags come from the server's own
  // removal record, never from anything the client sends. A `restoreTags` field must be inert.
  it('ignores a restoreTags field in the body entirely', async () => {
    h.assertLakeAccess.mockResolvedValue({ id: 'lake1' });
    const { res } = makeRes();

    await call(req('POST', { id: 'lake1', fabFileId: 'f1' }, { restoreTags: ['forged:tag'] }), res);

    expect(h.addFileToDataLake).toHaveBeenCalledWith(
      { userId: 'u1', isAdmin: false },
      'lake1',
      'f1',
      expect.anything()
    );
  });
});
