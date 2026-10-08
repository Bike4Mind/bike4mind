import { describe, it, expect, vi, beforeEach } from 'vitest';

// Runs the REAL org gate (orgAccess) against a mocked org repository, so an appointed org admin's
// read-vs-write standing is proven through the route rather than asserted on a mocked gate.
// github-connection.test.ts covers the handler logic with the gate stubbed.
const ORG = '650000000000000000000abc';
const OWNER = '650000000000000000000111';
const MANAGER = '650000000000000000000222';
const APPOINTED_ADMIN = '650000000000000000000333';
const STRANGER = '650000000000000000000444';

const h = vi.hoisted(() => ({
  orgFindById: vi.fn(),
  dlFindById: vi.fn(),
  connFindByDataLakeIdAny: vi.fn(),
  countByGitHubConnectionIdInDataLake: vi.fn(async () => 3),
  requestGitHubLakeDisconnect: vi.fn(),
  buildGitHubLakeAuthorizeUrl: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const routes: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign((req: { method?: string }, res: unknown) => routes[req.method ?? 'GET']?.(req, res), {
      use: () => chain,
      get: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((routes.GET = fns[fns.length - 1]), chain),
      post: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((routes.POST = fns[fns.length - 1]), chain),
      delete: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((routes.DELETE = fns[fns.length - 1]), chain),
    });
    return chain;
  },
}));
vi.mock('@server/middlewares/featureFlag', () => ({ requireFeatureEnabled: () => () => {} }));
vi.mock('@bike4mind/database/infra', () => ({ organizationRepository: { findById: h.orgFindById } }));
vi.mock('@server/utils/resolveActiveOrg', () => ({ resolveActiveOrg: vi.fn() }));
vi.mock('@server/integrations/github/dataLake/lakeAppClient', () => ({ getGitHubLakeAppConfig: vi.fn() }));
// resolveConnectableLake is the REAL one: it is the connect route's org gate, and stubbing it would
// leave the POST refusal for an appointed admin unproven.
vi.mock('@server/integrations/github/dataLake/githubLakeConnection', async importOriginal => {
  const actual = await importOriginal<typeof import('@server/integrations/github/dataLake/githubLakeConnection')>();
  return {
    buildGitHubLakeAuthorizeUrl: h.buildGitHubLakeAuthorizeUrl,
    requestGitHubLakeDisconnect: h.requestGitHubLakeDisconnect,
    requireGitHubLakeAppConfig: vi.fn(),
    resolveConnectableLake: actual.resolveConnectableLake,
    toGitHubLakeConnectionResponse: (conn: { id: string }, fileCount: number) => ({ id: conn.id, fileCount }),
  };
});
vi.mock('@bike4mind/database', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/database')>();
  return {
    ...actual,
    dataLakeRepository: { ...actual.dataLakeRepository, findById: h.dlFindById },
    fabFileRepository: {
      ...actual.fabFileRepository,
      countByGitHubConnectionIdInDataLake: h.countByGitHubConnectionIdInDataLake,
    },
    orgGitHubLakeConnectionRepository: {
      ...actual.orgGitHubLakeConnectionRepository,
      findByDataLakeIdAny: h.connFindByDataLakeIdAny,
    },
  };
});

import handler from '../github-connection';

const makeRes = () => {
  const json = vi.fn();
  const send = vi.fn();
  const status = vi.fn(() => ({ json, send }));
  return { res: { json, send, status } as never, json, send, status };
};
const makeReq = (method: string, userId: string) =>
  ({
    method,
    query: { id: 'lake1' },
    user: { id: userId, isAdmin: false },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  }) as never;
const run = (req: unknown, res: unknown) => (handler as (req: unknown, res: unknown) => Promise<void>)(req, res);

describe('/api/data-lakes/[id]/github-connection - appointed org admin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.orgFindById.mockResolvedValue({ id: ORG, userId: OWNER, managerId: MANAGER, adminUserIds: [APPOINTED_ADMIN] });
    h.dlFindById.mockResolvedValue({ id: 'lake1', organizationId: ORG, datalakeTag: 'datalake:lake1' });
    h.connFindByDataLakeIdAny.mockResolvedValue({ id: 'conn1', organizationId: ORG });
  });

  it('GET answers 200 with the status for an appointed admin, flagged as unable to manage', async () => {
    const { res, json } = makeRes();
    await run(makeReq('GET', APPOINTED_ADMIN), res);
    expect(json).toHaveBeenCalledWith({ connection: { id: 'conn1', fileCount: 3 }, canManage: false });
  });

  it('GET answers a null connection with canManage false for an appointed admin on a lake with none', async () => {
    h.connFindByDataLakeIdAny.mockResolvedValue(null);
    const { res, json } = makeRes();
    await run(makeReq('GET', APPOINTED_ADMIN), res);
    expect(json).toHaveBeenCalledWith({ connection: null, canManage: false });
  });

  it.each([
    ['owner', OWNER],
    ['manager', MANAGER],
  ])('GET flags the org %s as able to manage', async (_role, userId) => {
    const { res, json } = makeRes();
    await run(makeReq('GET', userId), res);
    expect(json).toHaveBeenCalledWith({ connection: { id: 'conn1', fileCount: 3 }, canManage: true });
  });

  it('GET still 404s a user with no standing on the org, without reading the connection', async () => {
    const { res } = makeRes();
    await expect(run(makeReq('GET', STRANGER), res)).rejects.toThrow(/not found/i);
    expect(h.connFindByDataLakeIdAny).not.toHaveBeenCalled();
  });

  it('POST (connect) still 404s an appointed admin through the real gate and never builds an authorize URL', async () => {
    const { res } = makeRes();
    await expect(run(makeReq('POST', APPOINTED_ADMIN), res)).rejects.toThrow(/not found/i);
    expect(h.buildGitHubLakeAuthorizeUrl).not.toHaveBeenCalled();
  });

  it('DELETE still 404s an appointed admin and never queues a disconnect', async () => {
    const { res } = makeRes();
    await expect(run(makeReq('DELETE', APPOINTED_ADMIN), res)).rejects.toThrow(/not found/i);
    expect(h.requestGitHubLakeDisconnect).not.toHaveBeenCalled();
  });
});
