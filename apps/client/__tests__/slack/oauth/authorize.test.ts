import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ForbiddenError } from '@bike4mind/common';

const { routeHandlers } = vi.hoisted(() => ({
  routeHandlers: {} as Record<string, (req: unknown, res: unknown) => Promise<unknown>>,
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain = {
      get(fn: (req: unknown, res: unknown) => Promise<unknown>) {
        routeHandlers.GET = fn;
        return chain;
      },
    };
    return chain;
  },
}));
vi.mock('@server/integrations/slack/slackPackageInit', () => ({ initializeSlackPackage: vi.fn() }));

const mockCreateInstallProvider = vi.fn();
vi.mock('@bike4mind/slack', () => ({
  createInstallProvider: (...args: unknown[]) => mockCreateInstallProvider(...args),
  getInstallUrlOptionsForWorkspace: async () => ({ scopes: ['chat:write'], redirectUri: 'https://example.com/cb' }),
}));

import '@pages/api/slack/oauth/authorize';
import { readStateNonceHash, NONCE_SLOT } from '@server/auth/oauthFlowCookie';

const makeRes = () => createMocks().res;
const setCookies = (res: ReturnType<typeof makeRes>) =>
  [res.getHeader('Set-Cookie')].flat().filter(Boolean).map(String);
const makeReq = (isAdmin: boolean, query: Record<string, string> = { workspaceId: 'ws-1' }) => ({
  query,
  user: { id: 'u1', isAdmin },
  logger: { info: vi.fn() },
});

describe('GET /api/slack/oauth/authorize', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateInstallProvider.mockResolvedValue({ generateInstallUrl: async () => 'https://slack.com/oauth?state=s' });
  });

  it('refuses a non-admin before minting any state or cookie', async () => {
    const res = makeRes();
    await expect(routeHandlers.GET(makeReq(false), res)).rejects.toBeInstanceOf(ForbiddenError);
    expect(setCookies(res)).toEqual([]);
    expect(mockCreateInstallProvider).not.toHaveBeenCalled();
  });

  it('rejects a missing workspaceId with 400 and sets no cookie', async () => {
    const res = makeRes();
    await routeHandlers.GET(makeReq(true, {}), res);

    expect(res._getStatusCode()).toBe(400);
    expect(setCookies(res)).toEqual([]);
    expect(mockCreateInstallProvider).not.toHaveBeenCalled();
  });

  it('sets an HttpOnly install-slot nonce cookie whose hash is bound into the state', async () => {
    const res = makeRes();
    await routeHandlers.GET(makeReq(true), res);

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
});
