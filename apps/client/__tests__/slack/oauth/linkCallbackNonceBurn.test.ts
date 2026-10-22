import { describe, it, expect, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';

vi.mock('@server/middlewares/baseApi', () => import('@server/qa/testing/baseApiStub'));
vi.mock('@server/integrations/slack/slackPackageInit', () => ({ initializeSlackPackage: vi.fn() }));
vi.mock('@bike4mind/observability', () => ({
  Logger: vi.fn(function () {
    return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  }),
}));
vi.mock('@bike4mind/database/infra', () => ({
  slackDevWorkspaceRepository: {},
  orgSlackWorkspaceRepository: {},
  organizationRepository: {},
}));
vi.mock('@bike4mind/database/auth', () => ({ User: {}, userRepository: {} }));
vi.mock('@server/security/tokenEncryption', () => ({ encryptToken: vi.fn() }));
vi.mock('@server/integrations/integrationAuditLogger', () => ({
  IntegrationAuditLogger: { create: () => ({ failure: vi.fn(), success: vi.fn(), setUserId: vi.fn() }) },
}));
vi.mock('@bike4mind/slack', () => ({
  getOAuthWorkspaceWithCredentials: vi.fn(),
  buildUserLinkRedirectUri: vi.fn(),
  getSystemSlackAppCredentials: vi.fn(),
  verifyUserLinkStateToken: () => {
    throw new Error('state verifier blew up');
  },
  verifyOrgSlackConnectStateToken: () => {
    throw new Error('state verifier blew up');
  },
}));

import userLinkCallback from '@pages/api/slack/oauth/user-link/callback';
import orgConnectCallback from '@pages/api/slack/oauth/org-connect/callback';

describe.each([
  ['user-link', userLinkCallback, 'slack-user-link'],
  ['org-connect', orgConnectCallback, 'org-slack-connect'],
])('%s callback nonce burn', (_name, handler, slot) => {
  it('expires the nonce cookie even when the state verifier throws', async () => {
    const { req, res } = createMocks({
      method: 'GET',
      query: { code: 'c', state: 's' },
      headers: { cookie: `b4m_oauth_nonce_${slot}=x` },
    });
    Object.assign(req, { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } });
    await (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res);

    const cookies = [res.getHeader('Set-Cookie')].flat().map(String);
    expect(cookies.some(c => c.startsWith(`b4m_oauth_nonce_${slot}=;`) && c.includes('Max-Age=0'))).toBe(true);
  });
});
