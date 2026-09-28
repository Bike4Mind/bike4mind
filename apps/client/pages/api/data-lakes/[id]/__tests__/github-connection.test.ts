import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InternalServerError } from '@server/utils/errors';

// Unit test of the per-lake GitHub connection status/install/disconnect route. Repo + auth gate +
// the githubLakeConnection lib (which has its own dedicated unit tests) are mocked.
const h = vi.hoisted(() => ({
  verifyOrgAccess: vi.fn(),
  dlFindById: vi.fn(),
  connFindByDataLakeIdAny: vi.fn(),
  getGitHubLakeAppConfig: vi.fn(),
  buildGitHubLakeConnectUrls: vi.fn(),
  releaseGitHubLakeConnection: vi.fn(),
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
vi.mock('@server/utils/orgAccess', () => ({ verifyOrgAccess: h.verifyOrgAccess }));
vi.mock('@server/integrations/github/dataLake/lakeAppClient', () => ({
  getGitHubLakeAppConfig: h.getGitHubLakeAppConfig,
}));
vi.mock('@server/integrations/github/dataLake/githubLakeConnection', () => ({
  buildGitHubLakeConnectUrls: h.buildGitHubLakeConnectUrls,
  releaseGitHubLakeConnection: h.releaseGitHubLakeConnection,
  requireGitHubLakeAppConfig: h.requireGitHubLakeAppConfig,
  resolveConnectableLake: h.resolveConnectableLake,
  toGitHubLakeConnectionResponse: h.toGitHubLakeConnectionResponse,
}));
vi.mock('@bike4mind/database', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/database')>();
  return {
    ...actual,
    dataLakeRepository: { ...actual.dataLakeRepository, findById: h.dlFindById },
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
  const status = vi.fn(() => ({ json }));
  return { res: { json, status } as never, json, status };
};
const makeReq = (method: string, extra: Record<string, unknown> = {}) =>
  ({ method, query: { id: 'lake1' }, user: { id: 'u1', isAdmin: false }, ...extra }) as never;
const run = (req: unknown, res: unknown) => (handler as (req: unknown, res: unknown) => Promise<void>)(req, res);

describe('/api/data-lakes/[id]/github-connection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.dlFindById.mockResolvedValue({ id: 'lake1', organizationId: 'orgA' });
    h.verifyOrgAccess.mockResolvedValue({ id: 'orgA' });
    h.requireGitHubLakeAppConfig.mockImplementation(config => {
      if (!config) throw new InternalServerError('The data-lake GitHub App is not configured');
      return config;
    });
  });

  it('registers the feature-flag gate for both EnableDataLakes and EnableDataLakeGitHub', () => {
    expect(flagGateCallsAtLoad).toEqual(['EnableDataLakes', 'EnableDataLakeGitHub']);
  });

  describe('GET', () => {
    it('resolves null for a personal (org-less) lake without checking org access', async () => {
      h.dlFindById.mockResolvedValue({ id: 'lake1', organizationId: undefined });
      const { res, json } = makeRes();
      await run(makeReq('GET'), res);
      expect(json).toHaveBeenCalledWith({ connection: null });
      expect(h.verifyOrgAccess).not.toHaveBeenCalled();
    });

    it('404s when the lake does not exist', async () => {
      h.dlFindById.mockResolvedValue(null);
      const { res } = makeRes();
      await expect(run(makeReq('GET'), res)).rejects.toThrow(/not found/i);
    });

    it('returns a response with exactly the documented connection fields', async () => {
      h.connFindByDataLakeIdAny.mockResolvedValue({ id: 'conn1', organizationId: 'orgA' });
      h.toGitHubLakeConnectionResponse.mockReturnValue({
        id: 'conn1',
        accountLogin: 'acme',
        repositoryId: 100,
        repositoryFullName: 'acme/one',
        connectedBy: 'u1',
        connectedAt: new Date('2024-01-01'),
      });
      const { res, json } = makeRes();
      await run(makeReq('GET'), res);
      const { connection } = json.mock.calls[0][0];
      expect(Object.keys(connection).sort()).toEqual(
        ['accountLogin', 'connectedAt', 'connectedBy', 'id', 'repositoryFullName', 'repositoryId'].sort()
      );
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
      h.buildGitHubLakeConnectUrls.mockReturnValue({
        installUrl: 'https://github.com/apps/test-app/installations/new?state=abc',
        authorizeUrl: 'https://github.com/login/oauth/authorize?client_id=client-1&state=abc',
      });
    });

    it('asserts the write scope before doing anything else', async () => {
      const { res } = makeRes();
      const req = makeReq('POST', { apiKeyInfo: { scopes: [] } });
      await expect(run(req, res)).rejects.toThrow(/read-only for data lakes/i);
      expect(h.resolveConnectableLake).not.toHaveBeenCalled();
      expect(h.buildGitHubLakeConnectUrls).not.toHaveBeenCalled();
    });

    it('500s when the GitHub App is not configured on this deployment', async () => {
      h.getGitHubLakeAppConfig.mockReturnValue(null);
      const { res } = makeRes();
      await expect(run(makeReq('POST'), res)).rejects.toThrow(/not configured/i);
      expect(h.resolveConnectableLake).not.toHaveBeenCalled();
    });

    it('returns both installUrl and authorizeUrl', async () => {
      const { res, json } = makeRes();
      await run(makeReq('POST'), res);
      expect(json).toHaveBeenCalledWith({
        installUrl: 'https://github.com/apps/test-app/installations/new?state=abc',
        authorizeUrl: 'https://github.com/login/oauth/authorize?client_id=client-1&state=abc',
      });
    });

    it('propagates a resolveConnectableLake error (e.g. a conflicting existing connection)', async () => {
      h.resolveConnectableLake.mockRejectedValue(
        new Error('This data lake is already connected to a GitHub repository')
      );
      const { res } = makeRes();
      await expect(run(makeReq('POST'), res)).rejects.toThrow(/already connected/i);
      expect(h.buildGitHubLakeConnectUrls).not.toHaveBeenCalled();
    });
  });

  describe('DELETE', () => {
    it('returns installationRetained: false when there is nothing to release', async () => {
      h.connFindByDataLakeIdAny.mockResolvedValue(null);
      const { res, json } = makeRes();
      await run(makeReq('DELETE'), res);
      expect(json).toHaveBeenCalledWith({ installationRetained: false });
      expect(h.releaseGitHubLakeConnection).not.toHaveBeenCalled();
    });

    it('delegates to releaseGitHubLakeConnection and returns its result', async () => {
      const conn = { id: 'conn1', organizationId: 'orgA' };
      h.connFindByDataLakeIdAny.mockResolvedValue(conn);
      h.getGitHubLakeAppConfig.mockReturnValue({ slug: 'test-app' });
      h.releaseGitHubLakeConnection.mockResolvedValue({ installationRetained: true });
      const { res, json } = makeRes();
      await run(makeReq('DELETE'), res);
      expect(h.releaseGitHubLakeConnection).toHaveBeenCalledWith(conn, { slug: 'test-app' });
      expect(json).toHaveBeenCalledWith({ installationRetained: true });
    });

    it('404s a personal (org-less) lake', async () => {
      h.dlFindById.mockResolvedValue({ id: 'lake1', organizationId: undefined });
      const { res } = makeRes();
      await expect(run(makeReq('DELETE'), res)).rejects.toThrow(/not found/i);
      expect(h.verifyOrgAccess).not.toHaveBeenCalled();
    });
  });
});
