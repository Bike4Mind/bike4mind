import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestError, ConflictError, InternalServerError, NotFoundError } from '@server/utils/errors';

const h = vi.hoisted(() => ({
  verifyOrgAccess: vi.fn(),
  dlFindById: vi.fn(),
  connFindByDataLakeIdAny: vi.fn(),
  connRecordLastError: vi.fn(),
  sendToQueue: vi.fn(),
  requireFeatureEnabled: vi.fn(() => () => {}),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const routes: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign((req: { method?: string }, res: unknown) => routes[req.method ?? 'GET']?.(req, res), {
      use: () => chain,
      post: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((routes.POST = fns[fns.length - 1]), chain),
    });
    return chain;
  },
}));
vi.mock('@bike4mind/server-utils/middlewares/featureFlag', () => ({
  requireFeatureEnabled: (flag: string) => h.requireFeatureEnabled(flag),
}));
vi.mock('@server/utils/orgAccess', () => ({ verifyOrgAccess: h.verifyOrgAccess }));
vi.mock('@server/utils/sqs', () => ({ sendToQueue: h.sendToQueue }));
vi.mock('@bike4mind/database', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/database')>();
  return {
    ...actual,
    dataLakeRepository: { ...actual.dataLakeRepository, findById: h.dlFindById },
    orgGitHubLakeConnectionRepository: {
      ...actual.orgGitHubLakeConnectionRepository,
      findByDataLakeIdAny: h.connFindByDataLakeIdAny,
      recordLastError: h.connRecordLastError,
    },
  };
});

import handler from '../sync';

const flagGateCallsAtLoad = h.requireFeatureEnabled.mock.calls.map(call => (call as unknown[])[0]);

const makeRes = () => {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  return { res: { json, status } as never, json, status };
};
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const makeReq = () => ({ method: 'POST', query: { id: 'lake1' }, user: { id: 'u1', isAdmin: false }, logger }) as never;
const run = (req: unknown, res: unknown) => (handler as (req: unknown, res: unknown) => Promise<void>)(req, res);
const CONN = { id: 'conn1', organizationId: 'orgA', enabled: true, status: 'connected' };

describe('POST /api/data-lakes/[id]/github-connection/sync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.dlFindById.mockResolvedValue({ id: 'lake1', organizationId: 'orgA', status: 'active' });
    h.verifyOrgAccess.mockResolvedValue({ id: 'orgA' });
    h.connFindByDataLakeIdAny.mockResolvedValue(CONN);
    h.sendToQueue.mockResolvedValue(undefined);
  });

  it('gates on both EnableDataLakes and EnableDataLakeGitHub', () => {
    expect(flagGateCallsAtLoad).toEqual(['EnableDataLakes', 'EnableDataLakeGitHub']);
  });

  it('enqueues a manual re-sync and answers 202', async () => {
    const { res, status, json } = makeRes();
    await run(makeReq(), res);
    expect(h.sendToQueue).toHaveBeenCalledWith('https://sqs.test/githubLakeIngestQueue', {
      connectionId: 'conn1',
      manual: true,
    });
    expect(status).toHaveBeenCalledWith(202);
    expect(json).toHaveBeenCalledWith({ connectionId: 'conn1', status: 'queued' });
  });

  it('checks org access before looking up the connection', async () => {
    h.verifyOrgAccess.mockRejectedValue(new NotFoundError('Data lake not found'));
    await expect(run(makeReq(), makeRes().res)).rejects.toBeInstanceOf(NotFoundError);
    expect(h.connFindByDataLakeIdAny).not.toHaveBeenCalled();
  });

  it('404s a missing lake', async () => {
    h.dlFindById.mockResolvedValue(null);
    await expect(run(makeReq(), makeRes().res)).rejects.toBeInstanceOf(NotFoundError);
  });

  describe('personal (org-less) lake', () => {
    const PERSONAL_LAKE = { id: 'lake1', organizationId: undefined, createdByUserId: 'u1', status: 'active' };
    const PERSONAL_CONN = { id: 'conn1', connectedBy: 'u1', enabled: true, status: 'connected' };

    beforeEach(() => {
      h.dlFindById.mockResolvedValue(PERSONAL_LAKE);
      h.connFindByDataLakeIdAny.mockResolvedValue(PERSONAL_CONN);
    });

    it('lets the creator re-sync without an org check', async () => {
      const { res, status, json } = makeRes();
      await run(makeReq(), res);
      expect(h.verifyOrgAccess).not.toHaveBeenCalled();
      expect(h.sendToQueue).toHaveBeenCalledWith('https://sqs.test/githubLakeIngestQueue', {
        connectionId: 'conn1',
        manual: true,
      });
      expect(status).toHaveBeenCalledWith(202);
      expect(json).toHaveBeenCalledWith({ connectionId: 'conn1', status: 'queued' });
    });

    it('404s a non-creator, even a platform admin, before looking up the connection', async () => {
      const req = { ...(makeReq() as object), user: { id: 'u2', isAdmin: true } } as never;
      await expect(run(req, makeRes().res)).rejects.toBeInstanceOf(NotFoundError);
      expect(h.connFindByDataLakeIdAny).not.toHaveBeenCalled();
      expect(h.sendToQueue).not.toHaveBeenCalled();
    });

    it('404s a connection owned by another user', async () => {
      h.connFindByDataLakeIdAny.mockResolvedValue({ ...PERSONAL_CONN, connectedBy: 'u2' });
      await expect(run(makeReq(), makeRes().res)).rejects.toBeInstanceOf(NotFoundError);
      expect(h.sendToQueue).not.toHaveBeenCalled();
    });

    it('404s an org-owned connection on a personal lake', async () => {
      h.connFindByDataLakeIdAny.mockResolvedValue({ ...PERSONAL_CONN, organizationId: 'orgA' });
      await expect(run(makeReq(), makeRes().res)).rejects.toBeInstanceOf(NotFoundError);
      expect(h.sendToQueue).not.toHaveBeenCalled();
    });
  });

  it('404s when the lake has no GitHub connection, or one from another org', async () => {
    h.connFindByDataLakeIdAny.mockResolvedValue(null);
    await expect(run(makeReq(), makeRes().res)).rejects.toBeInstanceOf(NotFoundError);
    h.connFindByDataLakeIdAny.mockResolvedValue({ ...CONN, organizationId: 'orgB' });
    await expect(run(makeReq(), makeRes().res)).rejects.toBeInstanceOf(NotFoundError);
    expect(h.sendToQueue).not.toHaveBeenCalled();
  });

  it('400s a lake that is not ingestable', async () => {
    h.dlFindById.mockResolvedValue({ id: 'lake1', organizationId: 'orgA', status: 'archived' });
    await expect(run(makeReq(), makeRes().res)).rejects.toBeInstanceOf(BadRequestError);
  });

  it('409s a disabled connection', async () => {
    h.connFindByDataLakeIdAny.mockResolvedValue({ ...CONN, enabled: false });
    await expect(run(makeReq(), makeRes().res)).rejects.toBeInstanceOf(ConflictError);
    expect(h.sendToQueue).not.toHaveBeenCalled();
  });

  it('409s while a live sync holds the claim', async () => {
    h.connFindByDataLakeIdAny.mockResolvedValue({ ...CONN, status: 'syncing', syncClaimedAt: new Date() });
    await expect(run(makeReq(), makeRes().res)).rejects.toBeInstanceOf(ConflictError);
  });

  it('lets a stale claim through so a dead sync cannot wedge the button', async () => {
    h.connFindByDataLakeIdAny.mockResolvedValue({
      ...CONN,
      status: 'syncing',
      syncClaimedAt: new Date(Date.now() - 21 * 60_000),
    });
    await run(makeReq(), makeRes().res);
    expect(h.sendToQueue).toHaveBeenCalled();
  });

  it('records lastError and 500s when the enqueue fails, mirroring the connect flow', async () => {
    h.sendToQueue.mockRejectedValue(new Error('SQS unavailable'));
    h.connRecordLastError.mockResolvedValue(undefined);
    await expect(run(makeReq(), makeRes().res)).rejects.toBeInstanceOf(InternalServerError);
    expect(h.connRecordLastError).toHaveBeenCalledWith('conn1', expect.any(String));
  });
});
