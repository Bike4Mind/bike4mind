import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ForbiddenError } from '@server/utils/errors';

// Unit test of the repository picker's list route. The connect lib (which has its own dedicated
// unit tests) is mocked; the route itself only wires the request/nonce/config through.
const h = vi.hoisted(() => ({
  readStateNonceHash: vi.fn(),
  getGitHubLakeAppConfig: vi.fn(),
  listGitHubLakeRepositoryChoices: vi.fn(),
  requireGitHubLakeAppConfig: vi.fn(),
  requireFeatureEnabled: vi.fn(() => () => {}),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const routes: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign((req: { method?: string }, res: unknown) => routes[req.method ?? 'GET']?.(req, res), {
      use: () => chain,
      get: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((routes.GET = fns[fns.length - 1]), chain),
    });
    return chain;
  },
}));
vi.mock('@server/middlewares/featureFlag', () => ({
  requireFeatureEnabled: (flag: string) => h.requireFeatureEnabled(flag),
}));
vi.mock('@server/auth/oauthFlowCookie', async importOriginal => {
  const actual = await importOriginal<typeof import('@server/auth/oauthFlowCookie')>();
  return { ...actual, readStateNonceHash: h.readStateNonceHash };
});
vi.mock('@server/integrations/github/dataLake/lakeAppClient', () => ({
  getGitHubLakeAppConfig: h.getGitHubLakeAppConfig,
}));
vi.mock('@server/integrations/github/dataLake/githubLakeConnection', () => ({
  listGitHubLakeRepositoryChoices: h.listGitHubLakeRepositoryChoices,
  requireGitHubLakeAppConfig: h.requireGitHubLakeAppConfig,
}));

import handler from '../repositories';
import { NONCE_SLOT } from '@server/auth/oauthFlowCookie';

const flagGateCallsAtLoad = h.requireFeatureEnabled.mock.calls.map(call => call[0]);

const makeRes = () => {
  const json = vi.fn();
  return { res: { json } as never, json };
};
const makeReq = () => ({ method: 'GET', query: { id: 'lake1' }, user: { id: 'u1', isAdmin: false } }) as never;
const run = (req: unknown, res: unknown) => (handler as (req: unknown, res: unknown) => Promise<void>)(req, res);

const CHOICES = { installations: [], installUrl: 'https://github.com/apps/test-app/installations/new?state=abc' };

describe('GET /api/data-lakes/[id]/github-connection/repositories', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.readStateNonceHash.mockReturnValue('nonce-hash');
    h.getGitHubLakeAppConfig.mockReturnValue({ slug: 'test-app' });
    h.requireGitHubLakeAppConfig.mockImplementation(config => config);
    h.listGitHubLakeRepositoryChoices.mockResolvedValue(CHOICES);
  });

  it('registers the feature-flag gate for both EnableDataLakes and EnableDataLakeGitHub', () => {
    expect(flagGateCallsAtLoad).toEqual(['EnableDataLakes', 'EnableDataLakeGitHub']);
  });

  it('refuses when the GitHub App is not configured on this deployment', async () => {
    h.getGitHubLakeAppConfig.mockReturnValue(null);
    h.requireGitHubLakeAppConfig.mockImplementation(() => {
      throw new Error('The data-lake GitHub App is not configured on this deployment');
    });
    const { res } = makeRes();
    await expect(run(makeReq(), res)).rejects.toThrow(/not configured/i);
    expect(h.listGitHubLakeRepositoryChoices).not.toHaveBeenCalled();
  });

  it('passes the lake id, user, nonce hash, and config through', async () => {
    const { res } = makeRes();
    await run(makeReq(), res);
    expect(h.listGitHubLakeRepositoryChoices).toHaveBeenCalledWith({
      config: { slug: 'test-app' },
      user: { id: 'u1', isAdmin: false },
      dataLakeId: 'lake1',
      nonceHash: 'nonce-hash',
    });
  });

  it('reads the nonce hash from the github-lake-connect cookie slot', async () => {
    const { res } = makeRes();
    await run(makeReq(), res);
    expect(h.readStateNonceHash).toHaveBeenCalledWith(expect.anything(), NONCE_SLOT.githubLakeConnect);
  });

  it('answers with the choices response', async () => {
    const { res, json } = makeRes();
    await run(makeReq(), res);
    expect(json).toHaveBeenCalledWith(CHOICES);
  });

  it('403s once the flow has expired (no live grant for this browser)', async () => {
    h.listGitHubLakeRepositoryChoices.mockRejectedValue(new ForbiddenError('Your GitHub authorization expired.'));
    const { res } = makeRes();
    await expect(run(makeReq(), res)).rejects.toMatchObject({ statusCode: 403 });
  });
});
