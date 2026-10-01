import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConflictError, ForbiddenError } from '@server/utils/errors';

// Unit test of the repository-pick completion route. The connect lib (which has its own dedicated
// unit tests) is mocked; the request body's Zod validation runs for real.
const h = vi.hoisted(() => ({
  readStateNonceHash: vi.fn(),
  clearStateNonce: vi.fn(),
  getGitHubLakeAppConfig: vi.fn(),
  completeGitHubLakeConnection: vi.fn(),
  requireGitHubLakeAppConfig: vi.fn(),
  toGitHubLakeConnectionResponse: vi.fn(),
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
vi.mock('@server/middlewares/featureFlag', () => ({
  requireFeatureEnabled: (flag: string) => h.requireFeatureEnabled(flag),
}));
vi.mock('@server/auth/oauthFlowCookie', async importOriginal => {
  const actual = await importOriginal<typeof import('@server/auth/oauthFlowCookie')>();
  return { ...actual, readStateNonceHash: h.readStateNonceHash, clearStateNonce: h.clearStateNonce };
});
vi.mock('@server/integrations/github/dataLake/lakeAppClient', () => ({
  getGitHubLakeAppConfig: h.getGitHubLakeAppConfig,
}));
vi.mock('@server/integrations/github/dataLake/githubLakeConnection', () => ({
  completeGitHubLakeConnection: h.completeGitHubLakeConnection,
  requireGitHubLakeAppConfig: h.requireGitHubLakeAppConfig,
  toGitHubLakeConnectionResponse: h.toGitHubLakeConnectionResponse,
}));

import handler from '../complete';
import { NONCE_SLOT } from '@server/auth/oauthFlowCookie';

const flagGateCallsAtLoad = h.requireFeatureEnabled.mock.calls.map(call => call[0]);

const makeRes = () => {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  return { res: { json, status } as never, json, status };
};
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const makeReq = (body: Record<string, unknown>) =>
  ({ method: 'POST', query: { id: 'lake1' }, body, user: { id: 'u1', isAdmin: false }, logger }) as never;
const run = (req: unknown, res: unknown) => (handler as (req: unknown, res: unknown) => Promise<void>)(req, res);

const VALID_BODY = { installationId: 42, repositoryId: 100 };

describe('POST /api/data-lakes/[id]/github-connection/complete', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.readStateNonceHash.mockReturnValue('nonce-hash');
    h.getGitHubLakeAppConfig.mockReturnValue({ slug: 'test-app' });
    h.requireGitHubLakeAppConfig.mockImplementation(config => config);
    h.completeGitHubLakeConnection.mockResolvedValue({ id: 'conn1' });
    h.toGitHubLakeConnectionResponse.mockReturnValue({ id: 'conn1', accountLogin: 'acme' });
  });

  it('registers the feature-flag gate for both EnableDataLakes and EnableDataLakeGitHub', () => {
    expect(flagGateCallsAtLoad).toEqual(['EnableDataLakes', 'EnableDataLakeGitHub']);
  });

  it('400s a missing field in the body', async () => {
    const { res } = makeRes();
    await expect(run(makeReq({ installationId: 42 }), res)).rejects.toThrow();
    expect(h.completeGitHubLakeConnection).not.toHaveBeenCalled();
  });

  it('400s a non-positive repositoryId', async () => {
    const { res } = makeRes();
    await expect(run(makeReq({ ...VALID_BODY, repositoryId: -1 }), res)).rejects.toThrow();
    expect(h.completeGitHubLakeConnection).not.toHaveBeenCalled();
  });

  it('passes the lake id, nonce hash, pick, user, logger, and config through', async () => {
    const { res } = makeRes();
    await run(makeReq(VALID_BODY), res);
    expect(h.completeGitHubLakeConnection).toHaveBeenCalledWith({
      config: { slug: 'test-app' },
      user: { id: 'u1', isAdmin: false },
      dataLakeId: 'lake1',
      nonceHash: 'nonce-hash',
      installationId: 42,
      repositoryId: 100,
      logger,
    });
  });

  it('201s with the connection on success', async () => {
    const { res, status, json } = makeRes();
    await run(makeReq(VALID_BODY), res);
    expect(status).toHaveBeenCalledWith(201);
    expect(json).toHaveBeenCalledWith({ connection: { id: 'conn1', accountLogin: 'acme' } });
    // A connection minted just now has ingested nothing: its first sync is only enqueued.
    expect(h.toGitHubLakeConnectionResponse).toHaveBeenCalledWith(expect.anything(), 0);
  });

  it('clears the nonce cookie on success', async () => {
    const { res } = makeRes();
    await run(makeReq(VALID_BODY), res);
    expect(h.clearStateNonce).toHaveBeenCalledWith(res, NONCE_SLOT.githubLakeConnect);
  });

  it('does not clear the nonce cookie on failure - the flow stays alive so the user can pick again', async () => {
    h.completeGitHubLakeConnection.mockRejectedValue(new ForbiddenError('Your GitHub authorization expired.'));
    const { res } = makeRes();
    await expect(run(makeReq(VALID_BODY), res)).rejects.toMatchObject({ statusCode: 403 });
    expect(h.clearStateNonce).not.toHaveBeenCalled();
  });

  it('propagates a conflict from a racing connect without clearing the nonce', async () => {
    h.completeGitHubLakeConnection.mockRejectedValue(new ConflictError('That repository is already connected.'));
    const { res } = makeRes();
    await expect(run(makeReq(VALID_BODY), res)).rejects.toMatchObject({ statusCode: 409 });
    expect(h.clearStateNonce).not.toHaveBeenCalled();
  });

  it('reads the nonce hash from the github-lake-connect cookie slot', async () => {
    const { res } = makeRes();
    await run(makeReq(VALID_BODY), res);
    expect(h.readStateNonceHash).toHaveBeenCalledWith(expect.anything(), NONCE_SLOT.githubLakeConnect);
  });
});
