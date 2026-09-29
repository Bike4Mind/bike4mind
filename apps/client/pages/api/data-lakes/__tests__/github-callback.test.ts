import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UnauthorizedError } from '@server/utils/errors';

// Unit test of the GitHub App install callback. The state/nonce plumbing and the connect-completion
// lib (each with their own dedicated unit tests) are mocked; the request body's Zod validation runs
// for real.
const h = vi.hoisted(() => ({
  readStateNonceHash: vi.fn(),
  clearStateNonce: vi.fn(),
  getGitHubLakeAppConfig: vi.fn(),
  completeGitHubLakeConnection: vi.fn(),
  requireGitHubLakeAppConfig: vi.fn(),
  toGitHubLakeConnectionResponse: vi.fn(),
  verifyGitHubLakeState: vi.fn(),
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
  verifyGitHubLakeState: h.verifyGitHubLakeState,
}));

import handler from '../github-callback';
import { NONCE_SLOT } from '@server/auth/oauthFlowCookie';

// Captured at module load time, before beforeEach clears mock call history.
const flagGateCallsAtLoad = h.requireFeatureEnabled.mock.calls.map(call => call[0]);

const makeRes = () => {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  return { res: { json, status } as never, json, status };
};
const makeReq = (body: Record<string, unknown>) =>
  ({ method: 'POST', body, user: { id: 'u1', isAdmin: false } }) as never;
const run = (req: unknown, res: unknown) => (handler as (req: unknown, res: unknown) => Promise<void>)(req, res);

const VALID_BODY = { state: 'state-token', code: 'the-code', installationId: '42' };

describe('POST /api/data-lakes/github-callback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.readStateNonceHash.mockReturnValue('nonce-hash');
    h.verifyGitHubLakeState.mockReturnValue('lake-from-state');
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
    await expect(run(makeReq({ state: 'x', code: 'y' }), res)).rejects.toThrow();
    expect(h.completeGitHubLakeConnection).not.toHaveBeenCalled();
  });

  it('400s a non-numeric installationId', async () => {
    const { res } = makeRes();
    await expect(run(makeReq({ ...VALID_BODY, installationId: 'not-a-number' }), res)).rejects.toThrow();
    expect(h.completeGitHubLakeConnection).not.toHaveBeenCalled();
  });

  it('401s and never completes the connection when state verification fails', async () => {
    h.verifyGitHubLakeState.mockImplementation(() => {
      throw new UnauthorizedError('Invalid authorization state.');
    });
    const { res } = makeRes();
    await expect(run(makeReq(VALID_BODY), res)).rejects.toThrow(/invalid authorization state/i);
    expect(h.completeGitHubLakeConnection).not.toHaveBeenCalled();
  });

  it('passes the lake id returned by state verification, not anything from the body', async () => {
    h.verifyGitHubLakeState.mockReturnValue('lake-xyz');
    const { res } = makeRes();
    await run(makeReq(VALID_BODY), res);
    expect(h.completeGitHubLakeConnection).toHaveBeenCalledWith(
      expect.objectContaining({ dataLakeId: 'lake-xyz', installationId: 42, code: 'the-code' })
    );
  });

  it('201s with the connection on success', async () => {
    const { res, status, json } = makeRes();
    await run(makeReq(VALID_BODY), res);
    expect(status).toHaveBeenCalledWith(201);
    expect(json).toHaveBeenCalledWith({ connection: { id: 'conn1', accountLogin: 'acme' } });
  });

  it('clears the nonce cookie on success', async () => {
    const { res } = makeRes();
    await run(makeReq(VALID_BODY), res);
    expect(h.clearStateNonce).toHaveBeenCalledWith(res, NONCE_SLOT.githubLakeConnect);
  });

  it('clears the nonce cookie on failure too', async () => {
    h.completeGitHubLakeConnection.mockRejectedValue(new Error('boom'));
    const { res } = makeRes();
    await expect(run(makeReq(VALID_BODY), res)).rejects.toThrow('boom');
    expect(h.clearStateNonce).toHaveBeenCalledWith(res, NONCE_SLOT.githubLakeConnect);
  });

  it('reads the nonce hash from the github-lake-connect cookie slot', async () => {
    const { res } = makeRes();
    await run(makeReq(VALID_BODY), res);
    expect(h.readStateNonceHash).toHaveBeenCalledWith(expect.anything(), NONCE_SLOT.githubLakeConnect);
  });
});
