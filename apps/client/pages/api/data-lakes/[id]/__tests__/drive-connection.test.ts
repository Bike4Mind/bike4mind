import { describe, it, expect, vi, beforeEach } from 'vitest';

// Unit test of the per-lake Drive connection status/disconnect route (D2). Repo + auth gate mocked.
const h = vi.hoisted(() => ({
  verifyOrgAccess: vi.fn(),
  dlFindById: vi.fn(),
  connFindByDataLakeId: vi.fn(),
  connRelease: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const routes: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign((req: { method?: string }, res: unknown) => routes[req.method ?? 'GET']?.(req, res), {
      use: () => chain,
      get: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((routes.GET = fns[fns.length - 1]), chain),
      delete: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((routes.DELETE = fns[fns.length - 1]), chain),
      post: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((routes.POST = fns[fns.length - 1]), chain),
    });
    return chain;
  },
}));
vi.mock('@server/middlewares/featureFlag', () => ({ requireFeatureEnabled: () => () => {} }));
vi.mock('@server/utils/orgAccess', () => ({ verifyOrgAccess: h.verifyOrgAccess }));
vi.mock('@bike4mind/database', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/database')>();
  return {
    ...actual,
    dataLakeRepository: { ...actual.dataLakeRepository, findById: h.dlFindById },
    orgGoogleDriveConnectionRepository: {
      ...actual.orgGoogleDriveConnectionRepository,
      findByDataLakeId: h.connFindByDataLakeId,
      release: h.connRelease,
    },
  };
});

import handler from '../drive-connection';

const makeRes = () => {
  const json = vi.fn();
  const send = vi.fn();
  const status = vi.fn(() => ({ json, send }));
  return { res: { json, send, status } as never, json, send, status };
};
const makeReq = (method: string) => ({ method, query: { id: 'lake1' }, user: { id: 'u1', isAdmin: false } }) as never;
const run = (req: unknown, res: unknown) => (handler as (req: unknown, res: unknown) => Promise<void>)(req, res);

describe('/api/data-lakes/[id]/drive-connection (D2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.dlFindById.mockResolvedValue({ id: 'lake1', organizationId: 'orgA' });
    h.verifyOrgAccess.mockResolvedValue({ id: 'orgA' });
  });

  it('GET returns a credential-free connection view', async () => {
    h.connFindByDataLakeId.mockResolvedValue({
      id: 'conn1',
      driveFolderId: 'Folder123',
      folderName: 'Docs',
      status: 'connected',
      enabled: true,
      oauthRefreshToken: 'SHOULD-NOT-LEAK',
    });
    const { res, json } = makeRes();
    await run(makeReq('GET'), res);

    const payload = json.mock.calls[0][0];
    expect(payload.connection).toMatchObject({
      id: 'conn1',
      driveFolderId: 'Folder123',
      folderName: 'Docs',
      status: 'connected',
    });
    expect(JSON.stringify(payload)).not.toContain('SHOULD-NOT-LEAK');
  });

  it('GET returns null when no connection feeds the lake', async () => {
    h.connFindByDataLakeId.mockResolvedValue(null);
    const { res, json } = makeRes();
    await run(makeReq('GET'), res);
    expect(json).toHaveBeenCalledWith({ connection: null });
  });

  it('DELETE releases the connection (frees the folder claim) and 204s', async () => {
    h.connFindByDataLakeId.mockResolvedValue({ id: 'conn1' });
    h.connRelease.mockResolvedValue(true);
    const { res, status } = makeRes();
    await run(makeReq('DELETE'), res);
    expect(h.connRelease).toHaveBeenCalledWith('conn1', 'orgA');
    expect(status).toHaveBeenCalledWith(204);
    // The gate + release are scoped to the LAKE's org, never a caller-supplied one.
    expect(h.verifyOrgAccess).toHaveBeenCalledWith(expect.anything(), 'orgA');
  });

  it('DELETE 204s even when there is nothing to release', async () => {
    h.connFindByDataLakeId.mockResolvedValue(null);
    const { res, status } = makeRes();
    await run(makeReq('DELETE'), res);
    expect(h.connRelease).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(204);
  });

  it('DELETE 409s (does NOT hard-delete) while a sync is in progress', async () => {
    // Hard-deleting under a live ingest would orphan the running handler's connection while the UI
    // reads "Disconnected"; make the caller wait until the sync finishes (or its claim goes stale).
    h.connFindByDataLakeId.mockResolvedValue({ id: 'conn1', status: 'syncing' });
    const { res, status } = makeRes();
    await run(makeReq('DELETE'), res);
    expect(h.connRelease).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(409);
  });

  it('denies a caller who is not an org owner/manager', async () => {
    h.verifyOrgAccess.mockRejectedValue(new Error('Organization not found'));
    const { res } = makeRes();
    await expect(run(makeReq('GET'), res)).rejects.toThrow(/organization not found/i);
    expect(h.connFindByDataLakeId).not.toHaveBeenCalled();
  });

  it('404s a personal (org-less) lake', async () => {
    h.dlFindById.mockResolvedValue({ id: 'lake1', organizationId: undefined });
    const { res } = makeRes();
    await expect(run(makeReq('GET'), res)).rejects.toThrow(/not found/i);
    expect(h.verifyOrgAccess).not.toHaveBeenCalled();
  });
});
