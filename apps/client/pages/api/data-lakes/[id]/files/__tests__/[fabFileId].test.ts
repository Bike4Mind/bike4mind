import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  assertLakeAccess: vi.fn(),
  assertLakeWritable: vi.fn(),
  removeFileFromDataLake: vi.fn(),
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
  },
}));
vi.mock('@bike4mind/database', () => ({
  dataLakeRepository: {},
  fabFileRepository: {},
  userRepository: {},
}));
vi.mock('@server/dataLakes/toAccessContext', () => ({ toAccessContext: h.toAccessContext }));

import handler from '../[fabFileId]';

const makeRes = () => {
  const json = vi.fn();
  return { res: { json, status: vi.fn(() => ({ json })) } as never, json };
};
const req = (query: Record<string, string>, body: unknown = undefined) => ({ method: 'DELETE', query, body }) as never;
const call = (r: unknown, res: unknown) => (handler as (req: unknown, res: unknown) => Promise<void>)(r, res);

describe('DELETE /api/data-lakes/[id]/files/[fabFileId]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.toAccessContext.mockResolvedValue({ userId: 'u1', isAdmin: false });
    h.assertLakeWritable.mockReturnValue(undefined);
    h.removeFileFromDataLake.mockResolvedValue({ success: true, fileCount: 2, totalSizeBytes: 30 });
  });

  it('removes the file against the RESOLVED lake and returns the service result verbatim', async () => {
    // The route accepts an id OR a slug and assertLakeAccess resolves it, so the service must
    // get lake.id - handing it the raw query value would address the wrong lake for a slug.
    h.assertLakeAccess.mockResolvedValue({ id: 'lake-oid-1', slug: 'my-lake' });
    const { res, json } = makeRes();

    await call(req({ id: 'my-lake', fabFileId: 'f1' }), res);

    expect(h.removeFileFromDataLake).toHaveBeenCalledWith(
      { userId: 'u1', isAdmin: false },
      'lake-oid-1',
      'f1',
      expect.anything()
    );
    expect(json).toHaveBeenCalledWith({ success: true, fileCount: 2, totalSizeBytes: 30 });
  });

  it('does not remove anything when the access gate denies the lake', async () => {
    h.assertLakeAccess.mockRejectedValue(new Error('Data lake not found'));
    const { res } = makeRes();

    await expect(call(req({ id: 'lake1', fabFileId: 'f1' }), res)).rejects.toThrow(/not found/i);
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

    await expect(call(req({ id: 'opti', fabFileId: 'f1' }), res)).rejects.toThrow(/read-only/i);
    expect(h.removeFileFromDataLake).not.toHaveBeenCalled();
  });

  it('forwards an admin actor through to the service (untested before, so a route that hardcoded isAdmin: false would have gone unnoticed)', async () => {
    h.assertLakeAccess.mockResolvedValue({ id: 'lake1' });
    h.toAccessContext.mockResolvedValue({ userId: 'root', isAdmin: true });
    const { res } = makeRes();

    await call(req({ id: 'lake1', fabFileId: 'f1' }), res);

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

    await call(req({ id: 'lake1', fabFileId: 'f1' }, { userId: 'attacker', isAdmin: true }), res);

    expect(h.removeFileFromDataLake).toHaveBeenCalledWith(
      { userId: 'u1', isAdmin: false },
      'lake1',
      'f1',
      expect.anything()
    );
  });
});
