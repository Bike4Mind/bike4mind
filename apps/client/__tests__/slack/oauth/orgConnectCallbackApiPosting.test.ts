import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

vi.mock('@server/middlewares/baseApi', () => import('@server/qa/testing/baseApiStub'));
vi.mock('@server/integrations/slack/slackPackageInit', () => ({ initializeSlackPackage: vi.fn() }));
vi.mock('@bike4mind/observability', () => ({
  Logger: vi.fn(function () {
    return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  }),
}));

const mockFindBySlackTeamIdAny = vi.fn();
const mockFindByOrganizationId = vi.fn();
const mockWorkspaceUpdate = vi.fn();
const mockWorkspaceCreate = vi.fn();
const mockClearApiPosting = vi.fn();
vi.mock('@bike4mind/database/infra', () => ({
  organizationRepository: { findById: vi.fn(async () => ({ id: 'org-a', name: 'Org A' })) },
  orgSlackWorkspaceRepository: {
    findBySlackTeamIdAny: (...args: unknown[]) => mockFindBySlackTeamIdAny(...args),
    findByOrganizationId: (...args: unknown[]) => mockFindByOrganizationId(...args),
    update: (...args: unknown[]) => mockWorkspaceUpdate(...args),
    create: (...args: unknown[]) => mockWorkspaceCreate(...args),
  },
  slackChannelConfigRepository: {
    clearApiPostingBySlackTeamId: (...args: unknown[]) => mockClearApiPosting(...args),
  },
}));
vi.mock('@bike4mind/database/auth', () => ({ User: {}, userRepository: {} }));
vi.mock('@bike4mind/server-utils/security/tokenEncryption', () => ({ encryptToken: vi.fn(() => 'enc') }));
vi.mock('@bike4mind/server-utils/integrations/integrationAuditLogger', () => ({
  IntegrationAuditLogger: {
    create: () => ({ failure: vi.fn(), success: vi.fn(), setUserId: vi.fn(), setWorkspaceId: vi.fn() }),
  },
}));
vi.mock('@bike4mind/server-utils/auth/oauthFlowCookie', () => ({
  consumeStateNonce: vi.fn(() => 'nonce-hash'),
  NONCE_SLOT: { orgSlackConnect: 'org-slack-connect' },
}));
const mockRecordAudit = vi.fn();
vi.mock('@bike4mind/server-utils/utils/adminAudit', () => ({
  recordAdminActionForActor: (...args: unknown[]) => mockRecordAudit(...args),
}));
vi.mock('@bike4mind/slack', () => ({
  getSystemSlackAppCredentials: vi.fn(async () => ({ clientId: 'id', clientSecret: 'secret', appId: 'A1' })),
  verifyOrgSlackConnectStateToken: () => ({ valid: true, payload: { organizationId: 'org-a', userId: 'user-1' } }),
}));

import orgConnectCallback from '@pages/api/slack/oauth/org-connect/callback';

async function runCallback() {
  const { req, res } = createMocks({
    method: 'GET',
    query: { code: 'c', state: 's' },
    headers: { host: 'example.test' },
  });
  Object.assign(req, { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } });
  await (orgConnectCallback as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res);
  return res;
}

describe('org-connect callback: API posting opt-ins', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ ok: true, team: { id: 'T-new', name: 'New' }, access_token: 'xoxb', bot_user_id: 'U1' }),
      }))
    );
    mockFindBySlackTeamIdAny.mockResolvedValue(null);
    mockFindByOrganizationId.mockResolvedValue(null);
    mockClearApiPosting.mockResolvedValue([]);
  });

  it('drops opt-ins on the connected workspace that another organization granted, and writes no audit when there are none', async () => {
    const res = await runCallback();

    expect(mockClearApiPosting).toHaveBeenCalledTimes(1);
    expect(mockClearApiPosting).toHaveBeenCalledWith('T-new', 'org-a');
    expect(mockRecordAudit).not.toHaveBeenCalled();
    expect(mockWorkspaceCreate).toHaveBeenCalled();
    expect(res._getData()).toContain('slack_connected=true');
  });

  it('on a reconnect to a different workspace, drops every opt-in of the old one and audits it', async () => {
    mockFindByOrganizationId.mockResolvedValue({ id: 'ws-1', slackTeamId: 'T-old' });
    mockClearApiPosting.mockImplementation(async (teamId: string) => (teamId === 'T-old' ? ['C-old'] : ['C-stale']));

    await runCallback();

    expect(mockClearApiPosting).toHaveBeenCalledWith('T-old');
    expect(mockRecordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ userId: 'user-1', scope: 'organization' }),
      expect.objectContaining({
        action: 'org.slack_channel_api_posting.updated',
        details: { slackTeamId: 'T-new', channelIds: ['C-stale', 'C-old'] },
      })
    );
    // The opt-ins are gone before the workspace record changes hands.
    expect(mockClearApiPosting.mock.invocationCallOrder[0]).toBeLessThan(
      mockWorkspaceUpdate.mock.invocationCallOrder[0]
    );
  });
});
