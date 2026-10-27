import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';

vi.mock('@server/middlewares/baseApi', () => import('@server/qa/testing/baseApiStub'));
vi.mock('@server/integrations/slack/slackPackageInit', () => ({ initializeSlackPackage: vi.fn() }));
vi.mock('@bike4mind/observability', () => ({
  Logger: vi.fn(function () {
    return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  }),
}));

const { mockFindDevWorkspace, mockFindOrgWorkspace, mockFindBySlackUserId, mockUpdate } = vi.hoisted(() => ({
  mockFindDevWorkspace: vi.fn(),
  mockFindOrgWorkspace: vi.fn(),
  mockFindBySlackUserId: vi.fn(),
  mockUpdate: vi.fn(),
}));

vi.mock('@bike4mind/database/infra', () => ({
  slackDevWorkspaceRepository: { findBySlackTeamIdWithToken: mockFindDevWorkspace },
  orgSlackWorkspaceRepository: { findBySlackTeamId: mockFindOrgWorkspace },
}));
vi.mock('@bike4mind/database/auth', () => ({
  User: { findByIdAndUpdate: mockUpdate },
  userRepository: { findBySlackUserId: mockFindBySlackUserId },
}));
vi.mock('@bike4mind/slack', () => ({
  getOAuthWorkspaceWithCredentials: vi.fn(async () => ({
    success: true,
    workspace: { slackAppId: 'A1', slackClientId: 'client-id', slackClientSecret: 'client-secret' },
  })),
  buildUserLinkRedirectUri: vi.fn(() => 'https://example.test/api/slack/oauth/user-link/callback'),
  verifyUserLinkStateToken: vi.fn(() => ({ valid: true, payload: { userId: 'user-1' } })),
}));
vi.mock('@bike4mind/server-utils/auth/oauthFlowCookie', () => ({
  consumeStateNonce: vi.fn(() => 'nonce-hash'),
  NONCE_SLOT: { slackUserLink: 'slack-user-link' },
}));
vi.mock('@bike4mind/server-utils/integrations/integrationAuditLogger', () => ({
  IntegrationAuditLogger: {
    create: () => ({ failure: vi.fn(), success: vi.fn(), setUserId: vi.fn(), setWorkspaceId: vi.fn() }),
  },
}));
vi.mock('@bike4mind/server-utils/security/tokenEncryption', () => ({
  encryptToken: (token: string) => `encrypted:${token}`,
}));

import handler from '@pages/api/slack/oauth/user-link/callback';

const routeHandler = handler as unknown as (req: unknown, res: unknown) => Promise<void>;

const tokenResponse = (body: Record<string, unknown>) => ({ ok: true, json: async () => body });

function run() {
  const { req, res } = createMocks({ method: 'GET', query: { code: 'code-1', state: 'state-1' } });
  return { res, promise: routeHandler(req, res) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFindDevWorkspace.mockResolvedValue({ name: 'Test workspace' });
  mockFindOrgWorkspace.mockResolvedValue(null);
  mockFindBySlackUserId.mockResolvedValue(null);
  mockUpdate.mockResolvedValue({});
  vi.stubGlobal('fetch', vi.fn());
});

describe('GET /api/slack/oauth/user-link/callback', () => {
  it('stores the Slack user and the workspace the OAuth response verified', async () => {
    vi.mocked(fetch).mockResolvedValue(
      tokenResponse({
        ok: true,
        authed_user: { id: 'U1', access_token: 'xoxp-token', scope: 'identity.basic,chat:write' },
        team: { id: 'T1', name: 'Team One' },
      }) as never
    );

    const { res, promise } = run();
    await promise;

    expect(mockUpdate).toHaveBeenCalledWith(
      'user-1',
      {
        $set: {
          'slackSettings.slackUserId': 'U1',
          'slackSettings.slackTeamId': 'T1',
          'slackSettings.slackUserScopes': ['identity.basic', 'chat:write'],
          'slackSettings.slackUserToken': 'encrypted:xoxp-token',
        },
      },
      { new: true }
    );
    expect(res._getRedirectUrl()).toBe('/profile?tab=integrations&slack_linked=true');
  });

  it('refuses an OAuth response that names no workspace and writes nothing', async () => {
    vi.mocked(fetch).mockResolvedValue(
      tokenResponse({ ok: true, authed_user: { id: 'U1', access_token: 'xoxp-token' } }) as never
    );

    const { res, promise } = run();
    await promise;

    expect(mockUpdate).not.toHaveBeenCalled();
    expect(res._getRedirectUrl()).toBe('/profile?tab=integrations&slack_error=no_user_id');
  });
});
