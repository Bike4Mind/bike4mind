import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

// Mock slackPackageInit to prevent transitive imports of @bike4mind/database and @server/*
vi.mock('@server/integrations/slack/slackPackageInit', () => ({
  initializeSlackPackage: vi.fn(),
}));

// Mock @bike4mind/common so tests work without core:build
vi.mock('@bike4mind/common', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@bike4mind/common').catch(() => ({}));
  return {
    ...actual,
    ROTATABLE_INTEGRATIONS: ['github', 'atlassian', 'slack', 'notion'] as const,
    McpServerName: { Github: 'github', Notion: 'notion' },
  };
});

// Mock baseApi to extract the handler function
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => ({
    post: (fn: any) => fn,
  }),
}));

// Mock database repositories
const mockFindById = vi.fn();
const mockFindOne = vi.fn();
const mockUpdateOne = vi.fn().mockResolvedValue({ modifiedCount: 0 });
const mockFindByIdAndUpdate = vi.fn().mockResolvedValue(null);

vi.mock('@bike4mind/database', () => ({
  userRepository: {
    findById: (...args: any[]) => mockFindById(...args),
  },
  mcpServerRepository: {
    findOne: (...args: any[]) => mockFindOne(...args),
  },
  User: {
    updateOne: (...args: any[]) => mockUpdateOne(...args),
    findByIdAndUpdate: (...args: any[]) => mockFindByIdAndUpdate(...args),
  },
  // getSettingsMap (mocked above) ignores this, but the route still references
  // the repository when building the adapter argument.
  adminSettingsRepository: {},
}));

// Mock audit logger
const mockAuditSuccess = vi.fn();
const mockAuditFailure = vi.fn();

vi.mock('@server/integrations/integrationAuditLogger', () => ({
  IntegrationAuditLogger: {
    create: vi.fn().mockReturnValue({
      success: (...args: any[]) => mockAuditSuccess(...args),
      failure: (...args: any[]) => mockAuditFailure(...args),
    }),
  },
}));

// Mock settings - preserve the rest of the @bike4mind/utils surface via importOriginal
// (consistent with notionConfig/disconnect tests; robust to future transitive utils imports).
vi.mock('@bike4mind/utils', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/utils')>()),
  getSettingsMap: vi.fn().mockResolvedValue({ githubMcpClientId: 'test-client-id' }),
  getSettingsValue: vi.fn().mockReturnValue('test-client-id'),
}));

// Mock Atlassian config
vi.mock('@server/integrations/jira/atlassianConfig', () => ({
  getAtlassianOAuthConfig: vi.fn().mockResolvedValue({
    clientId: 'atlassian-client-id',
    redirectUri: 'https://app.test.com/api/mcp-servers/atlassian/callback',
  }),
  ATLASSIAN_OAUTH_SCOPES: 'read:jira-work write:jira-work',
}));

// Mock Notion config
vi.mock('@server/integrations/notion', () => ({
  getNotionOAuthConfig: vi.fn().mockResolvedValue({
    clientId: 'notion-client-id',
    clientSecret: 'notion-client-secret',
    redirectUri: 'https://app.test.com/api/mcp-servers/notion/callback',
  }),
  NOTION_OAUTH_AUTHORIZE_URL: 'https://api.notion.com/v1/oauth/authorize',
}));

// Mock Slack helpers
vi.mock('@bike4mind/slack', () => ({
  getOAuthWorkspaceWithCredentials: vi.fn().mockResolvedValue({
    success: true,
    workspace: {
      slackClientId: 'slack-client-id',
      slackTeamId: 'T123',
    },
  }),
  buildUserLinkRedirectUri: vi.fn().mockReturnValue('https://app.test.com/api/slack/user-link/callback'),
  generateUserLinkStateToken: vi.fn().mockReturnValue('slack-state-token'),
  buildSlackOAuthUrl: vi.fn().mockReturnValue('https://slack.com/oauth/v2/authorize?test=1'),
}));

// Mock JWT
vi.mock('jsonwebtoken', () => ({
  default: {
    sign: vi.fn().mockReturnValue('test-jwt-token'),
  },
}));

// Mock Config
vi.mock('@server/utils/config', () => ({
  Config: {
    JWT_SECRET: 'test-jwt-secret',
  },
}));

// Mock CloudWatch
vi.mock('@server/utils/cloudwatch', () => ({
  recordTokenRotationInitiated: vi.fn(),
  recordTokenRotationFailed: vi.fn(),
}));

import handler from '../../../pages/api/integrations/[integration]/rotate-token';
import { recordTokenRotationInitiated, recordTokenRotationFailed } from '@server/utils/cloudwatch';
import { getSettingsValue } from '@bike4mind/utils';

function createReq(overrides: Record<string, unknown> = {}) {
  const { req, res } = createMocks({
    method: 'POST',
    query: { integration: 'github' },
    body: {},
    headers: { host: 'app.test.com' },
    ...overrides,
  });
  req.user = { id: 'user-123', isAdmin: false } as any;
  req.logger = { info: vi.fn(), error: vi.fn(), warn: vi.fn() } as any;
  return { req, res };
}

describe('/api/integrations/[integration]/rotate-token', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.APP_URL = 'https://app.test.com';
    mockFindById.mockResolvedValue({
      id: 'user-123',
      atlassianConnect: { status: 'connected' },
      slackSettings: { slackUserId: 'U123' },
      notionConnect: { status: 'connected', workspaceId: 'ws-123' },
    });
    mockFindOne.mockResolvedValue({ enabled: true });
    mockUpdateOne.mockResolvedValue({ modifiedCount: 0 });
    mockFindByIdAndUpdate.mockResolvedValue(null);
  });

  describe('input validation', () => {
    it('should reject invalid integration names', async () => {
      const { req, res } = createReq({ query: { integration: 'invalid' } });
      await handler(req as any, res as any);
      expect(res._getStatusCode()).toBe(400);
      expect(res._getJSONData().error).toContain('Invalid integration');
    });

    it('should accept valid integration names', async () => {
      for (const integration of ['github', 'atlassian', 'slack', 'notion']) {
        const { req, res } = createReq({ query: { integration } });
        await handler(req as any, res as any);
        expect(res._getStatusCode()).toBe(200);
      }
    });

    it('should sanitize invalid reasons to manual_rotation', async () => {
      const { req, res } = createReq({ body: { reason: 'arbitrary_string_with_high_cardinality' } });
      await handler(req as any, res as any);
      expect(res._getStatusCode()).toBe(200);
      expect(mockFindByIdAndUpdate).toHaveBeenCalledWith('user-123', {
        $set: {
          'integrationRotation.github': expect.objectContaining({
            lastRotationReason: 'manual_rotation',
          }),
        },
      });
    });

    it('should accept valid reason values', async () => {
      const { req, res } = createReq({ body: { reason: 'security_incident' } });
      await handler(req as any, res as any);
      expect(res._getStatusCode()).toBe(200);
      expect(mockFindByIdAndUpdate).toHaveBeenCalledWith('user-123', {
        $set: {
          'integrationRotation.github': expect.objectContaining({
            lastRotationReason: 'security_incident',
          }),
        },
      });
    });
  });

  describe('user and integration checks', () => {
    it('should return 404 when user not found', async () => {
      mockFindById.mockResolvedValue(null);
      const { req, res } = createReq();
      await handler(req as any, res as any);
      expect(res._getStatusCode()).toBe(404);
      expect(mockAuditFailure).toHaveBeenCalledWith('user_not_found');
    });

    it('should return 400 when GitHub is not connected', async () => {
      mockFindOne.mockResolvedValue(null);
      const { req, res } = createReq({ query: { integration: 'github' } });
      await handler(req as any, res as any);
      expect(res._getStatusCode()).toBe(400);
      expect(res._getJSONData().error).toContain('GitHub integration is not connected');
    });

    it('should return 400 when Atlassian is not connected', async () => {
      mockFindById.mockResolvedValue({ id: 'user-123', atlassianConnect: null });
      const { req, res } = createReq({ query: { integration: 'atlassian' } });
      await handler(req as any, res as any);
      expect(res._getStatusCode()).toBe(400);
      expect(res._getJSONData().error).toContain('Atlassian integration is not connected');
    });

    it('should return 400 when Slack is not connected', async () => {
      mockFindById.mockResolvedValue({ id: 'user-123', slackSettings: {} });
      const { req, res } = createReq({ query: { integration: 'slack' } });
      await handler(req as any, res as any);
      expect(res._getStatusCode()).toBe(400);
      expect(res._getJSONData().error).toContain('Slack integration is not connected');
    });

    it('should return 400 when Notion is not connected', async () => {
      mockFindById.mockResolvedValue({ id: 'user-123', notionConnect: null });
      const { req, res } = createReq({ query: { integration: 'notion' } });
      await handler(req as any, res as any);
      expect(res._getStatusCode()).toBe(400);
      expect(res._getJSONData().error).toContain('Notion integration is not connected');
    });
  });

  describe('successful rotation', () => {
    it('should return authUrl for GitHub rotation', async () => {
      const { req, res } = createReq({ query: { integration: 'github' } });
      await handler(req as any, res as any);
      expect(res._getStatusCode()).toBe(200);
      const data = res._getJSONData();
      expect(data.authUrl).toContain('github.com/login/oauth/authorize');
      expect(data.authUrl).toContain('client_id=test-client-id');
    });

    it('should return authUrl for Atlassian rotation', async () => {
      const { req, res } = createReq({ query: { integration: 'atlassian' } });
      await handler(req as any, res as any);
      expect(res._getStatusCode()).toBe(200);
      expect(res._getJSONData().authUrl).toContain('auth.atlassian.com/authorize');
    });

    it('should return authUrl for Slack rotation', async () => {
      const { req, res } = createReq({ query: { integration: 'slack' } });
      await handler(req as any, res as any);
      expect(res._getStatusCode()).toBe(200);
      expect(res._getJSONData().authUrl).toContain('slack.com/oauth');
    });

    it('should return authUrl for Notion rotation', async () => {
      const { req, res } = createReq({ query: { integration: 'notion' } });
      await handler(req as any, res as any);
      expect(res._getStatusCode()).toBe(200);
      expect(res._getJSONData().authUrl).toContain('api.notion.com/v1/oauth/authorize');
    });

    it('should stamp rotation record on user', async () => {
      const { req, res } = createReq();
      await handler(req as any, res as any);
      // First call initializes integrationRotation if null
      expect(mockUpdateOne).toHaveBeenCalledWith(
        { _id: 'user-123', integrationRotation: null },
        { $set: { integrationRotation: {} } }
      );
      // Second call sets the specific integration's rotation data atomically
      expect(mockFindByIdAndUpdate).toHaveBeenCalledWith('user-123', {
        $set: {
          'integrationRotation.github': expect.objectContaining({
            lastRotationInitiatedAt: expect.any(Date),
            lastRotationReason: 'manual_rotation',
          }),
        },
      });
    });

    it('should emit CloudWatch metric on success', async () => {
      const { req, res } = createReq();
      await handler(req as any, res as any);
      expect(recordTokenRotationInitiated).toHaveBeenCalledWith('github', 'manual_rotation');
    });

    it('should log audit success', async () => {
      const { req, res } = createReq();
      await handler(req as any, res as any);
      expect(mockAuditSuccess).toHaveBeenCalledWith({ reason: 'manual_rotation' });
    });
  });

  describe('resilience', () => {
    it('should return authUrl even if DB rotation stamp fails', async () => {
      mockUpdateOne.mockRejectedValue(new Error('DB connection lost'));
      const { req, res } = createReq({ query: { integration: 'github' } });
      await handler(req as any, res as any);
      expect(res._getStatusCode()).toBe(200);
      expect(res._getJSONData().authUrl).toContain('github.com');
      expect(req.logger.warn).toHaveBeenCalledWith(
        'Failed to stamp rotation record, proceeding with auth URL',
        expect.any(Object)
      );
    });

    it('should return 500 and emit failure metric when auth URL generation fails', async () => {
      vi.mocked(getSettingsValue).mockReturnValueOnce(null);
      const { req, res } = createReq({ query: { integration: 'github' } });
      await handler(req as any, res as any);
      expect(res._getStatusCode()).toBe(500);
      expect(recordTokenRotationFailed).toHaveBeenCalledWith('github', 'misconfiguration');
      expect(mockAuditFailure).toHaveBeenCalledWith('rotation_failed');
    });

    it('should use APP_URL for base URL when available', async () => {
      process.env.APP_URL = 'https://app.bike4mind.com';
      const { req, res } = createReq({ query: { integration: 'github' } });
      await handler(req as any, res as any);
      expect(res._getStatusCode()).toBe(200);
      expect(res._getJSONData().authUrl).toContain('redirect_uri=https%3A%2F%2Fapp.bike4mind.com');
    });

    it('should fallback to headers when APP_URL is not set', async () => {
      delete process.env.APP_URL;
      const { req, res } = createReq({
        query: { integration: 'github' },
        headers: { host: 'custom.host.com' },
      });
      await handler(req as any, res as any);
      expect(res._getStatusCode()).toBe(200);
      expect(res._getJSONData().authUrl).toContain('redirect_uri=https%3A%2F%2Fcustom.host.com');
    });
  });
});
