import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

// baseApi is stubbed (no auth chain) but errors go through the real errorHandler.
vi.mock('@server/middlewares/baseApi', () => import('@server/qa/testing/baseApiStub'));
vi.mock('@server/integrations/slack/slackPackageInit', () => ({ initializeSlackPackage: vi.fn() }));

const mockCreateInstallProvider = vi.fn();
const mockGetInstallUrlOptions = vi.fn();
vi.mock('@bike4mind/slack', () => ({
  createInstallProvider: (...args: unknown[]) => mockCreateInstallProvider(...args),
  getInstallUrlOptionsForWorkspace: (...args: unknown[]) => mockGetInstallUrlOptions(...args),
}));

import handler from '@pages/api/slack/oauth/authorize';
import { readStateNonceHash, NONCE_SLOT } from '@server/auth/oauthFlowCookie';

const call = async (isAdmin: boolean, query: Record<string, string> = { workspaceId: 'ws-1' }) => {
  const { req, res } = createMocks({ method: 'GET', query });
  Object.assign(req, {
    user: { id: 'u1', isAdmin },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  });
  await (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res);
  return res;
};
const setCookies = (res: Awaited<ReturnType<typeof call>>) =>
  [res.getHeader('Set-Cookie')].flat().filter(Boolean).map(String);
const isExpiry = (c: string) => c.startsWith('b4m_oauth_nonce_slack-app-install=;') && c.includes('Max-Age=0');

describe('GET /api/slack/oauth/authorize', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetInstallUrlOptions.mockResolvedValue({ scopes: ['chat:write'], redirectUri: 'https://example.com/cb' });
    mockCreateInstallProvider.mockResolvedValue({ generateInstallUrl: async () => 'https://slack.com/oauth?state=s' });
  });

  it('refuses a non-admin before minting any state or cookie', async () => {
    const res = await call(false);
    expect(res._getStatusCode()).toBe(403);
    expect(setCookies(res)).toEqual([]);
    expect(mockCreateInstallProvider).not.toHaveBeenCalled();
  });

  it('rejects a missing workspaceId with 400 and sets no cookie', async () => {
    const res = await call(true, {});

    expect(res._getStatusCode()).toBe(400);
    expect(setCookies(res)).toEqual([]);
    expect(mockCreateInstallProvider).not.toHaveBeenCalled();
  });

  it('sets an HttpOnly install-slot nonce cookie whose hash is bound into the state', async () => {
    const res = await call(true);

    const cookies = setCookies(res);
    expect(cookies).toHaveLength(1);
    const nonce = /^b4m_oauth_nonce_slack-app-install=([^;]+);/.exec(cookies[0])?.[1];
    expect(nonce).toBeDefined();
    expect(cookies[0]).toContain('HttpOnly');
    const expectedHash = readStateNonceHash(
      { headers: { cookie: `b4m_oauth_nonce_slack-app-install=${nonce}` } },
      NONCE_SLOT.slackAppInstall
    );
    expect(mockCreateInstallProvider).toHaveBeenCalledWith('ws-1', { nonceHash: expectedHash });
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ authUrl: 'https://slack.com/oauth?state=s' });
  });

  it('mints no nonce when the workspace cannot be resolved', async () => {
    mockGetInstallUrlOptions.mockRejectedValue(new Error('Workspace not found: ws-1'));
    const res = await call(true);

    expect(res._getStatusCode()).toBe(500);
    expect(setCookies(res)).toEqual([]);
    expect(mockCreateInstallProvider).not.toHaveBeenCalled();
  });

  it('expires the nonce when provider creation fails after it was issued', async () => {
    mockCreateInstallProvider.mockRejectedValue(new Error('Missing Slack OAuth credentials'));
    const res = await call(true);

    expect(res._getStatusCode()).toBe(500);
    expect(setCookies(res).some(isExpiry)).toBe(true);
  });
});
