import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConflictError, InternalServerError } from '@server/utils/errors';

// Unit test of the per-lake GitHub connection status/install/disconnect route. Repo + auth gate +
// the githubLakeConnection lib (which has its own dedicated unit tests) are mocked.
const h = vi.hoisted(() => ({
  verifyOrgAccess: vi.fn(),
  verifyOrgAdminRead: vi.fn(),
  dlFindById: vi.fn(),
  connFindByDataLakeIdAny: vi.fn(),
  countByGitHubConnectionIdInDataLake: vi.fn(),
  getGitHubLakeAppConfig: vi.fn(),
  buildGitHubLakeAuthorizeUrl: vi.fn(),
  requestGitHubLakeDisconnect: vi.fn(),
  requireGitHubLakeAppConfig: vi.fn(),
  resolveConnectableLake: vi.fn(),
  toGitHubLakeConnectionResponse: vi.fn(),
  requireFeatureEnabled: vi.fn(() => () => {}),
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
vi.mock('@server/middlewares/featureFlag', () => ({
  requireFeatureEnabled: (flag: string) => h.requireFeatureEnabled(flag),
}));
vi.mock('@server/utils/orgAccess', () => ({
  verifyOrgAccess: h.verifyOrgAccess,
  verifyOrgAdminRead: h.verifyOrgAdminRead,
}));
vi.mock('@server/integrations/github/dataLake/lakeAppClient', () => ({
  getGitHubLakeAppConfig: h.getGitHubLakeAppConfig,
}));
vi.mock('@server/integrations/github/dataLake/githubLakeConnection', () => ({
  buildGitHubLakeAuthorizeUrl: h.buildGitHubLakeAuthorizeUrl,
  requestGitHubLakeDisconnect: h.requestGitHubLakeDisconnect,
  requireGitHubLakeAppConfig: h.requireGitHubLakeAppConfig,
  resolveConnectableLake: h.resolveConnectableLake,
  toGitHubLakeConnectionResponse: h.toGitHubLakeConnectionResponse,
}));
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

// Captured at module load time, before beforeEach clears mock call history, so it reflects the
// `.use(requireFeatureEnabled(...))` calls the route registers on import.
const flagGateCallsAtLoad = h.requireFeatureEnabled.mock.calls.map(call => call[0]);

const makeRes = () => {
  const json = vi.fn();
  const send = vi.fn();
  const status = vi.fn(() => ({ json, send }));
  return { res: { json, status } as never, json, send, status };
};
const makeReq = (method: string, extra: Record<string, unknown> = {}) =>
  ({ method, query: { id: 'lake1' }, user: { id: 'u1', isAdmin: false }, ...extra }) as never;
const run = (req: unknown, res: unknown) => (handler as (req: unknown, res: unknown) => Promise<void>)(req, res);

describe('/api/data-lakes/[id]/github-connection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.dlFindById.mockResolvedValue({ id: 'lake1', organizationId: 'orgA' });
    h.verifyOrgAccess.mockResolvedValue({ id: 'orgA' });
    h.verifyOrgAdminRead.mockResolvedValue({ org: { id: 'orgA' }, canManage: true });
    h.requireGitHubLakeAppConfig.mockImplementation(config => {
      if (!config) throw new InternalServerError('The data-lake GitHub App is not configured');
      return config;
    });
  });

  it('registers the feature-flag gate for both EnableDataLakes and EnableDataLakeGitHub', () => {
    expect(flagGateCallsAtLoad).toEqual(['EnableDataLakes', 'EnableDataLakeGitHub']);
  });

  describe('GET', () => {
    it('resolves null with canManage false for a personal (org-less) lake without checking org access', async () => {
      h.dlFindById.mockResolvedValue({ id: 'lake1', organizationId: undefined });
      const { res, json } = makeRes();
      await run(makeReq('GET'), res);
      expect(json).toHaveBeenCalledWith({ connection: null, canManage: false });
      expect(h.verifyOrgAdminRead).not.toHaveBeenCalled();
      expect(h.verifyOrgAccess).not.toHaveBeenCalled();
    });

    it('404s when the lake does not exist', async () => {
      h.dlFindById.mockResolvedValue(null);
      const { res } = makeRes();
      await expect(run(makeReq('GET'), res)).rejects.toThrow(/not found/i);
    });

    it("counts the connection's files under the lake's tag and hands the count to the response", async () => {
      h.dlFindById.mockResolvedValue({ id: 'lake1', organizationId: 'orgA', datalakeTag: 'datalake:one' });
      h.connFindByDataLakeIdAny.mockResolvedValue({ id: 'conn1', organizationId: 'orgA' });
      h.countByGitHubConnectionIdInDataLake.mockResolvedValue(7);
      h.toGitHubLakeConnectionResponse.mockReturnValue({ id: 'conn1', fileCount: 7 });
      const { res, json } = makeRes();
      await run(makeReq('GET'), res);
      expect(h.countByGitHubConnectionIdInDataLake).toHaveBeenCalledWith('conn1', 'datalake:one');
      expect(h.toGitHubLakeConnectionResponse).toHaveBeenCalledWith({ id: 'conn1', organizationId: 'orgA' }, 7);
      expect(json).toHaveBeenCalledWith({ connection: { id: 'conn1', fileCount: 7 }, canManage: true });
    });

    it('resolves null without counting when the org lake has no connection', async () => {
      h.connFindByDataLakeIdAny.mockResolvedValue(null);
      const { res, json } = makeRes();
      await run(makeReq('GET'), res);
      expect(json).toHaveBeenCalledWith({ connection: null, canManage: true });
      expect(h.countByGitHubConnectionIdInDataLake).not.toHaveBeenCalled();
    });

    it('reads through the read gate and hands its canManage verdict to the response', async () => {
      h.verifyOrgAdminRead.mockResolvedValue({ org: { id: 'orgA' }, canManage: false });
      h.connFindByDataLakeIdAny.mockResolvedValue({ id: 'conn1', organizationId: 'orgA' });
      h.toGitHubLakeConnectionResponse.mockReturnValue({ id: 'conn1' });
      const { res, json } = makeRes();
      await run(makeReq('GET'), res);
      expect(h.verifyOrgAdminRead).toHaveBeenCalledWith(expect.anything(), 'orgA');
      expect(h.verifyOrgAccess).not.toHaveBeenCalled();
      expect(json).toHaveBeenCalledWith({ connection: { id: 'conn1' }, canManage: false });
    });

    it('404s a connection whose org does not match the lake (global finder, org-scoped defence)', async () => {
      h.connFindByDataLakeIdAny.mockResolvedValue({ id: 'conn1', organizationId: 'orgB' });
      const { res } = makeRes();
      await expect(run(makeReq('GET'), res)).rejects.toThrow(/not found/i);
    });
  });

  describe('POST', () => {
    beforeEach(() => {
      h.getGitHubLakeAppConfig.mockReturnValue({ slug: 'test-app', clientId: 'client-1' });
      h.resolveConnectableLake.mockResolvedValue({ lakeId: 'lake1', organizationId: 'orgA' });
      h.buildGitHubLakeAuthorizeUrl.mockReturnValue(
        'https://github.com/login/oauth/authorize?client_id=client-1&state=abc'
      );
    });

    it('asserts the write scope before doing anything else', async () => {
      const { res } = makeRes();
      const req = makeReq('POST', { apiKeyInfo: { scopes: [] } });
      await expect(run(req, res)).rejects.toThrow(/read-only for data lakes/i);
      expect(h.resolveConnectableLake).not.toHaveBeenCalled();
      expect(h.buildGitHubLakeAuthorizeUrl).not.toHaveBeenCalled();
    });

    it('refuses when the GitHub App is not configured on this deployment', async () => {
      h.getGitHubLakeAppConfig.mockReturnValue(null);
      const { res } = makeRes();
      await expect(run(makeReq('POST'), res)).rejects.toThrow(/not configured/i);
      expect(h.resolveConnectableLake).not.toHaveBeenCalled();
    });

    it('returns the authorizeUrl', async () => {
      const { res, json } = makeRes();
      await run(makeReq('POST'), res);
      expect(json).toHaveBeenCalledWith({
        authorizeUrl: 'https://github.com/login/oauth/authorize?client_id=client-1&state=abc',
      });
      expect(h.buildGitHubLakeAuthorizeUrl).toHaveBeenCalledWith(
        expect.anything(),
        { slug: 'test-app', clientId: 'client-1' },
        {
          userId: 'u1',
          dataLakeId: 'lake1',
        }
      );
    });

    it('propagates a resolveConnectableLake error (e.g. a conflicting existing connection)', async () => {
      h.resolveConnectableLake.mockRejectedValue(
        new Error('This data lake is already connected to a GitHub repository')
      );
      const { res } = makeRes();
      await expect(run(makeReq('POST'), res)).rejects.toThrow(/already connected/i);
      expect(h.buildGitHubLakeAuthorizeUrl).not.toHaveBeenCalled();
    });
  });

  describe('DELETE', () => {
    it('204s with nothing sent when there is no connection', async () => {
      h.connFindByDataLakeIdAny.mockResolvedValue(null);
      const { res, status, send, json } = makeRes();
      await run(makeReq('DELETE'), res);
      expect(status).toHaveBeenCalledWith(204);
      expect(send).toHaveBeenCalled();
      expect(json).not.toHaveBeenCalled();
      expect(h.requestGitHubLakeDisconnect).not.toHaveBeenCalled();
    });

    it('delegates to requestGitHubLakeDisconnect and answers 202 with its queued result', async () => {
      const conn = { id: 'conn1', organizationId: 'orgA' };
      h.connFindByDataLakeIdAny.mockResolvedValue(conn);
      h.requestGitHubLakeDisconnect.mockResolvedValue({ queued: true });
      const { res, status, json } = makeRes();
      const req = makeReq('DELETE', { logger: 'req-logger' });
      await run(req, res);
      expect(h.requestGitHubLakeDisconnect).toHaveBeenCalledWith(conn, 'req-logger');
      expect(status).toHaveBeenCalledWith(202);
      expect(json).toHaveBeenCalledWith({ success: true, queued: true });
    });

    it('reports queued: false when a purge is already progressing', async () => {
      const conn = { id: 'conn1', organizationId: 'orgA' };
      h.connFindByDataLakeIdAny.mockResolvedValue(conn);
      h.requestGitHubLakeDisconnect.mockResolvedValue({ queued: false });
      const { res, status, json } = makeRes();
      await run(makeReq('DELETE'), res);
      expect(status).toHaveBeenCalledWith(202);
      expect(json).toHaveBeenCalledWith({ success: true, queued: false });
    });

    it('propagates the 409 a live sync raises', async () => {
      h.connFindByDataLakeIdAny.mockResolvedValue({ id: 'conn1', organizationId: 'orgA' });
      h.requestGitHubLakeDisconnect.mockRejectedValue(new ConflictError('A sync is in progress'));
      const { res, json } = makeRes();
      await expect(run(makeReq('DELETE'), res)).rejects.toMatchObject({ statusCode: 409 });
      expect(json).not.toHaveBeenCalled();
    });

    it('404s a personal (org-less) lake', async () => {
      h.dlFindById.mockResolvedValue({ id: 'lake1', organizationId: undefined });
      const { res } = makeRes();
      await expect(run(makeReq('DELETE'), res)).rejects.toThrow(/not found/i);
      expect(h.verifyOrgAccess).not.toHaveBeenCalled();
    });
  });
});
