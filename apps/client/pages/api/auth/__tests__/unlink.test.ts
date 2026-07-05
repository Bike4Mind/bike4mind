import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { AuthStrategy } from '@bike4mind/common';

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => ({ post: (fn: any) => fn }),
}));

vi.mock('@server/middlewares/asyncHandler', () => ({
  asyncHandler: (fn: any) => fn,
}));

const mockUpdateOne = vi.fn();
const mockFindById = vi.fn();
vi.mock('@bike4mind/database', () => ({
  User: {
    findById: (...args: any[]) => mockFindById(...args),
    updateOne: (...args: any[]) => mockUpdateOne(...args),
  },
}));

import handler from '@pages/api/auth/unlink';

const OKTA_PROVIDER = { strategy: AuthStrategy.Okta, id: 'okta-id-1', accessToken: '' };
const GITHUB_PROVIDER = { strategy: AuthStrategy.Github, id: 'gh-id-1', accessToken: '' };

function makeReqRes(body: Record<string, unknown> = { strategy: AuthStrategy.Okta }) {
  const { req, res } = createMocks({ method: 'POST' });
  (req as any).body = body;
  (req as any).user = { id: 'user-123' };
  (req as any).logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { req, res };
}

function mockUser(authProviders: object[] = [OKTA_PROVIDER]) {
  mockFindById.mockResolvedValue({ authProviders });
}

describe('/api/auth/unlink', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateOne.mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });
  });

  it('removes the provider and returns success', async () => {
    mockUser([OKTA_PROVIDER, GITHUB_PROVIDER]);

    const { req, res } = makeReqRes();
    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ success: true });
    expect(mockUpdateOne).toHaveBeenCalledWith(
      { _id: 'user-123' },
      { $pull: { authProviders: { strategy: AuthStrategy.Okta } } }
    );
  });

  it('removes a non-Okta provider (generic by design)', async () => {
    mockUser([OKTA_PROVIDER, GITHUB_PROVIDER]);

    const { req, res } = makeReqRes({ strategy: AuthStrategy.Github });
    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(mockUpdateOne).toHaveBeenCalledWith(
      { _id: 'user-123' },
      { $pull: { authProviders: { strategy: AuthStrategy.Github } } }
    );
  });

  it('allows unlinking the last OAuth provider — email OTC always remains as sign-in method', async () => {
    // Passwordless: email OTC is always available, so removing the last OAuth
    // provider never strands the account. No password guard needed.
    mockUser([OKTA_PROVIDER]);

    const { req, res } = makeReqRes();
    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(mockUpdateOne).toHaveBeenCalledTimes(1);
  });

  it('returns 200 idempotently when provider not linked', async () => {
    mockUser([GITHUB_PROVIDER]);

    const { req, res } = makeReqRes();
    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(mockUpdateOne).not.toHaveBeenCalled();
  });

  it('rejects an invalid strategy', async () => {
    mockUser();
    const { req, res } = makeReqRes({ strategy: 'notavalidstrategy' });
    await expect(handler(req, res)).rejects.toThrow('Invalid request body');
    expect(mockUpdateOne).not.toHaveBeenCalled();
  });

  it('rejects a missing strategy', async () => {
    mockUser();
    const { req, res } = makeReqRes({});
    await expect(handler(req, res)).rejects.toThrow('Invalid request body');
    expect(mockUpdateOne).not.toHaveBeenCalled();
  });

  it('fetches user without password select (passwordless — no lockout check needed)', async () => {
    mockUser([OKTA_PROVIDER, GITHUB_PROVIDER]);

    const { req, res } = makeReqRes();
    await handler(req, res);

    expect(mockFindById).toHaveBeenCalledWith('user-123');
    // No .select('+password') - the password lockout guard was removed
  });

  it('logs the unlink action', async () => {
    mockUser([OKTA_PROVIDER, GITHUB_PROVIDER]);

    const { req, res } = makeReqRes();
    await handler(req, res);

    expect((req as any).logger.info).toHaveBeenCalledWith('Unlinked auth provider', {
      userId: 'user-123',
      strategy: AuthStrategy.Okta,
    });
  });
});
