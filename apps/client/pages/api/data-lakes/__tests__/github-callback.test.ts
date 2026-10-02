import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ForbiddenError } from '@server/utils/errors';

// Unit test of the authorize-first callback: exchanges GitHub's code and holds the user token for
// the picker, binding nothing yet. The state/nonce plumbing and the connect-completion lib (each
// with their own dedicated unit tests) are mocked; the request body's Zod validation runs for real.
const h = vi.hoisted(() => ({
  readStateNonceHash: vi.fn(),
  clearStateNonce: vi.fn(),
  getGitHubLakeAppConfig: vi.fn(),
  authorizeGitHubLakeConnection: vi.fn(),
  requireGitHubLakeAppConfig: vi.fn(),
  requireFeatureEnabled: vi.fn(() => () => {}),
  consumeGitHubLakeAuthGrant: vi.fn(),
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
  authorizeGitHubLakeConnection: h.authorizeGitHubLakeConnection,
  requireGitHubLakeAppConfig: h.requireGitHubLakeAppConfig,
}));
// The grant store has its own dedicated unit tests (githubLakeAuthGrant.test.ts).
vi.mock('@server/integrations/github/dataLake/githubLakeAuthGrant', () => ({
  consumeGitHubLakeAuthGrant: h.consumeGitHubLakeAuthGrant,
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
  ({ method: 'POST', body, user: { id: 'u1', isAdmin: false }, logger: { warn: vi.fn() } }) as never;
const run = (req: unknown, res: unknown) => (handler as (req: unknown, res: unknown) => Promise<void>)(req, res);

const VALID_BODY = { state: 'state-token', code: 'the-code' };

describe('POST /api/data-lakes/github-callback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.readStateNonceHash.mockReturnValue('nonce-hash');
    h.getGitHubLakeAppConfig.mockReturnValue({ slug: 'test-app' });
    h.requireGitHubLakeAppConfig.mockImplementation(config => config);
    h.authorizeGitHubLakeConnection.mockResolvedValue({ dataLakeId: 'lake1' });
    h.consumeGitHubLakeAuthGrant.mockResolvedValue(undefined);
  });

  it('registers the feature-flag gate for both EnableDataLakes and EnableDataLakeGitHub', () => {
    expect(flagGateCallsAtLoad).toEqual(['EnableDataLakes', 'EnableDataLakeGitHub']);
  });

  it('400s a missing field in the body', async () => {
    const { res } = makeRes();
    // A malformed body still burns the nonce: parseOrBadRequest throws before authorizeGitHubLakeConnection
    // is ever reached, so the catch block is the only thing that runs the cleanup.
    await expect(run(makeReq({ state: 'x' }), res)).rejects.toThrow();
    expect(h.authorizeGitHubLakeConnection).not.toHaveBeenCalled();
    expect(h.clearStateNonce).toHaveBeenCalledWith(res, NONCE_SLOT.githubLakeConnect);
  });

  it('403s and clears the nonce when state/nonce verification fails', async () => {
    h.authorizeGitHubLakeConnection.mockRejectedValue(new ForbiddenError('Invalid authorization state.'));
    const { res } = makeRes();
    await expect(run(makeReq(VALID_BODY), res)).rejects.toThrow(/invalid authorization state/i);
    expect(h.clearStateNonce).toHaveBeenCalledWith(res, NONCE_SLOT.githubLakeConnect);
  });

  it('passes state, code, nonceHash, user and config through to authorizeGitHubLakeConnection', async () => {
    const { res } = makeRes();
    await run(makeReq(VALID_BODY), res);
    expect(h.authorizeGitHubLakeConnection).toHaveBeenCalledWith({
      config: { slug: 'test-app' },
      user: { id: 'u1', isAdmin: false },
      state: 'state-token',
      code: 'the-code',
      nonceHash: 'nonce-hash',
    });
  });

  it('200s with the dataLakeId on success', async () => {
    const { res, json } = makeRes();
    await run(makeReq(VALID_BODY), res);
    expect(json).toHaveBeenCalledWith({ dataLakeId: 'lake1' });
  });

  it('does not clear the nonce cookie on success - it lives on through the repository picker', async () => {
    const { res } = makeRes();
    await run(makeReq(VALID_BODY), res);
    expect(h.clearStateNonce).not.toHaveBeenCalled();
  });

  it('clears the nonce cookie on a failure, so the flow restarts rather than being replayed', async () => {
    h.authorizeGitHubLakeConnection.mockRejectedValue(new Error('boom'));
    const { res } = makeRes();
    await expect(run(makeReq(VALID_BODY), res)).rejects.toThrow('boom');
    expect(h.clearStateNonce).toHaveBeenCalledWith(res, NONCE_SLOT.githubLakeConnect);
  });

  it('reads the nonce hash from the github-lake-connect cookie slot', async () => {
    const { res } = makeRes();
    await run(makeReq(VALID_BODY), res);
    expect(h.readStateNonceHash).toHaveBeenCalledWith(expect.anything(), NONCE_SLOT.githubLakeConnect);
  });

  it('releases a grant already held under this nonce on failure', async () => {
    h.authorizeGitHubLakeConnection.mockRejectedValue(new Error('boom'));
    const { res } = makeRes();
    await expect(run(makeReq(VALID_BODY), res)).rejects.toThrow('boom');
    expect(h.consumeGitHubLakeAuthGrant).toHaveBeenCalledWith({ slug: 'test-app' }, 'nonce-hash');
  });

  it('does not touch the grant store on success', async () => {
    const { res } = makeRes();
    await run(makeReq(VALID_BODY), res);
    expect(h.consumeGitHubLakeAuthGrant).not.toHaveBeenCalled();
  });

  it('logs and still rethrows the original error when releasing the grant itself throws', async () => {
    h.authorizeGitHubLakeConnection.mockRejectedValue(new Error('boom'));
    h.consumeGitHubLakeAuthGrant.mockRejectedValue(new Error('grant store unavailable'));
    const req = makeReq(VALID_BODY);
    const { res } = makeRes();
    await expect(run(req, res)).rejects.toThrow('boom');
    expect((req as { logger: { warn: ReturnType<typeof vi.fn> } }).logger.warn).toHaveBeenCalled();
    expect(h.clearStateNonce).toHaveBeenCalledWith(res, NONCE_SLOT.githubLakeConnect);
  });
});
