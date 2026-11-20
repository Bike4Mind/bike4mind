import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * GET /api/slack/oauth/authorize starts a workspace-wide Slack app install, so it needs
 * settings:manage. The real adminApi guard runs; the Slack and cookie helpers are mocked.
 */

type Handler = (req: { method?: string }, res: unknown, next: () => void) => unknown;
type Invocable = (req: unknown, res: unknown) => unknown;

const mockRefs = vi.hoisted(() => ({ getHandler: null as null | Invocable, postHandler: null as null | Invocable }));

// The chain runs adminApi's real permission guard (and any other use() middleware) ahead of the handler.
vi.mock('@server/middlewares/baseApi', () => {
  const guards: Handler[] = [];
  const gated = (method: string, fn: Invocable) => async (req: { method?: string }, res: unknown) => {
    req.method = method;
    for (const guard of guards) guard(req, res, () => {});
    return fn(req, res);
  };
  const chain = {
    use: (fn: Handler) => {
      guards.push(fn);
      return chain;
    },
    get: (fn: Invocable) => {
      mockRefs.getHandler = gated('GET', fn);
      return chain;
    },
    post: (fn: Invocable) => {
      mockRefs.postHandler = gated('POST', fn);
      return chain;
    },
  };
  return { baseApi: () => chain };
});

const slack = vi.hoisted(() => ({
  getInstallUrlOptionsForWorkspace: vi.fn(),
  createInstallProvider: vi.fn(),
  generateInstallUrl: vi.fn(),
}));
vi.mock('@bike4mind/server-utils/integrations/slack/slackPackageInit', () => ({ initializeSlackPackage: vi.fn() }));
const cookie = vi.hoisted(() => ({ issueStateNonce: vi.fn(() => 'nonce-hash') }));
vi.mock('@bike4mind/server-utils/auth/oauthFlowCookie', () => ({
  issueStateNonce: cookie.issueStateNonce,
  clearStateNonce: vi.fn(),
  NONCE_SLOT: { slackAppInstall: 'slackAppInstall' },
}));
vi.mock('@bike4mind/slack', () => ({
  getInstallUrlOptionsForWorkspace: slack.getInstallUrlOptionsForWorkspace,
  createInstallProvider: slack.createInstallProvider,
}));

import '@pages/api/slack/oauth/authorize';

const REFUSAL = 'Missing permission: settings:manage';

function call(user: { id: string; isAdmin: boolean; adminPermissions?: string[] }) {
  const { req, res } = createMocks({ method: 'GET', query: { workspaceId: 'ws-1' } });
  const request = req as unknown as { user: unknown; logger: unknown };
  request.user = user;
  request.logger = { info: vi.fn() };
  return { result: mockRefs.getHandler!(req, res), res };
}

describe('GET /api/slack/oauth/authorize - admin permission gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    slack.getInstallUrlOptionsForWorkspace.mockResolvedValue({ scopes: ['chat:write'], redirectUri: 'https://x/cb' });
    slack.generateInstallUrl.mockResolvedValue('https://slack.example/install');
    slack.createInstallProvider.mockResolvedValue({ generateInstallUrl: slack.generateInstallUrl });
  });

  it('refuses a signed-in non-admin before resolving the workspace', async () => {
    await expect(call({ id: 'u1', isAdmin: false }).result).rejects.toThrow(REFUSAL);
    expect(slack.getInstallUrlOptionsForWorkspace).not.toHaveBeenCalled();
    expect(cookie.issueStateNonce).not.toHaveBeenCalled();
  });

  it('admits a delegate holding settings:manage', async () => {
    const { result, res } = call({ id: 'u2', isAdmin: false, adminPermissions: ['settings:manage'] });
    await result;
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ authUrl: 'https://slack.example/install' });
  });

  it('refuses a delegate holding an unrelated permission', async () => {
    await expect(call({ id: 'u3', isAdmin: false, adminPermissions: ['users:moderate'] }).result).rejects.toThrow(
      REFUSAL
    );
    expect(slack.getInstallUrlOptionsForWorkspace).not.toHaveBeenCalled();
  });

  it('admits a full admin', async () => {
    const { result, res } = call({ id: 'admin1', isAdmin: true });
    await result;
    expect(res._getStatusCode()).toBe(200);
    expect(slack.createInstallProvider).toHaveBeenCalledTimes(1);
  });
});
