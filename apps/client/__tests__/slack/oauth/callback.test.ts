import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextApiRequest, NextApiResponse } from 'next';

// Mock slackPackageInit to prevent transitive imports of @bike4mind/database and @server/*
vi.mock('@server/integrations/slack/slackPackageInit', () => ({
  initializeSlackPackage: vi.fn(),
}));

// Mock dependencies
vi.mock('@bike4mind/observability', () => {
  const MockLogger = vi.fn(function () {
    return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  });
  MockLogger.info = vi.fn();
  MockLogger.warn = vi.fn();
  MockLogger.error = vi.fn();
  return { Logger: MockLogger };
});

// Mock the installer module
const mockHandleCallback = vi.fn();
const mockBinding = vi.fn();
let createProviderError: Error | undefined;
let onInstallCompleteCallback:
  ((metadata: { isReinstall: boolean; teamName: string; teamId: string }) => void) | undefined;

vi.mock('@bike4mind/slack', () => ({
  createInstallProvider: (
    onInstallComplete?: (metadata: { isReinstall: boolean; teamName: string; teamId: string }) => void,
    binding?: { expectedNonceHash?: string }
  ) => {
    onInstallCompleteCallback = onInstallComplete;
    mockBinding(binding);
    if (createProviderError) return Promise.reject(createProviderError);
    return {
      handleCallback: mockHandleCallback,
    };
  },
}));

import handler from '@pages/api/slack/oauth/callback';
import { readStateNonceHash, NONCE_SLOT } from '@server/auth/oauthFlowCookie';

const NONCE_COOKIE = 'b4m_oauth_nonce_slack-app-install=cookie-value';
const COOKIE_HASH = readStateNonceHash({ headers: { cookie: NONCE_COOKIE } }, NONCE_SLOT.slackAppInstall);

describe('Slack OAuth Callback', () => {
  let req: Partial<NextApiRequest>;
  let res: Partial<NextApiResponse>;

  beforeEach(() => {
    req = {
      method: 'GET',
      query: {},
      headers: { cookie: NONCE_COOKIE },
    };

    createProviderError = undefined;
    const headers: Record<string, unknown> = {};
    res = {
      getHeader: vi.fn((name: string) => headers[name]),
      setHeader: vi.fn((name: string, value: unknown) => {
        headers[name] = value;
        return res as NextApiResponse;
      }),
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
      redirect: vi.fn().mockReturnThis(),
      writableEnded: false,
    };

    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Method validation', () => {
    it('should reject non-GET requests', async () => {
      req.method = 'POST';

      await handler(req as NextApiRequest, res as NextApiResponse);

      expect(res.status).toHaveBeenCalledWith(405);
      expect(res.json).toHaveBeenCalledWith({ error: 'Method not allowed' });
    });
  });

  describe('OAuth callback handling', () => {
    it('should call handleCallback with correct options', async () => {
      req.query = { code: 'test-code', state: 'test-state' };

      // Mock handleCallback to simulate success
      mockHandleCallback.mockImplementation(async (_req, _res, options) => {
        // Simulate installationStore calling onInstallComplete
        onInstallCompleteCallback?.({ isReinstall: false, teamName: 'Test Workspace', teamId: 'T123' });
        await options.success(
          {
            team: { id: 'T123', name: 'Test Workspace' },
            bot: { userId: 'U123', token: 'xoxb-token', id: 'B123' },
            appId: 'A123',
          },
          {},
          _req,
          _res
        );
      });

      await handler(req as NextApiRequest, res as NextApiResponse);

      expect(mockHandleCallback).toHaveBeenCalled();
      expect(res.redirect).toHaveBeenCalledWith('/integrations/slack/success?workspace=Test+Workspace&teamId=T123');
    });

    it('should redirect to success page after successful OAuth', async () => {
      req.query = { code: 'test-code', state: 'test-state' };

      mockHandleCallback.mockImplementation(async (_req, _res, options) => {
        onInstallCompleteCallback?.({ isReinstall: false, teamName: 'My Company', teamId: 'T456' });
        await options.success(
          {
            team: { id: 'T456', name: 'My Company' },
            bot: { userId: 'U123', token: 'xoxb-token', id: 'B123' },
            appId: 'A123',
          },
          {},
          _req,
          _res
        );
      });

      await handler(req as NextApiRequest, res as NextApiResponse);

      expect(res.redirect).toHaveBeenCalledWith('/integrations/slack/success?workspace=My+Company&teamId=T456');
    });

    it('should add reinstall=true query param for reinstalls', async () => {
      req.query = { code: 'test-code', state: 'test-state' };

      mockHandleCallback.mockImplementation(async (_req, _res, options) => {
        onInstallCompleteCallback?.({ isReinstall: true, teamName: 'Existing Workspace', teamId: 'T789' });
        await options.success(
          {
            team: { id: 'T789', name: 'Existing Workspace' },
            bot: { userId: 'U123', token: 'xoxb-token', id: 'B123' },
            appId: 'A123',
          },
          {},
          _req,
          _res
        );
      });

      await handler(req as NextApiRequest, res as NextApiResponse);

      expect(res.redirect).toHaveBeenCalledWith(
        '/integrations/slack/success?workspace=Existing+Workspace&teamId=T789&reinstall=true'
      );
    });

    it('should handle OAuth failure', async () => {
      req.query = { code: 'invalid-code', state: 'test-state' };

      mockHandleCallback.mockImplementation(async (_req, _res, options) => {
        options.failure(new Error('invalid_code'), {}, _req, _res);
        throw new Error('invalid_code');
      });

      await handler(req as NextApiRequest, res as NextApiResponse);

      expect(res.redirect).toHaveBeenCalledWith('/integrations/slack/error?reason=invalid_code');
    });

    it('should handle state validation error', async () => {
      req.query = { code: 'test-code', state: 'invalid-state' };

      mockHandleCallback.mockRejectedValue(new Error('Invalid state parameter'));

      await handler(req as NextApiRequest, res as NextApiResponse);

      expect(res.redirect).toHaveBeenCalledWith('/integrations/slack/error?reason=invalid_params');
    });

    it('should handle access_denied error', async () => {
      req.query = { code: 'test-code', state: 'test-state' };

      mockHandleCallback.mockRejectedValue(new Error('access_denied by user'));

      await handler(req as NextApiRequest, res as NextApiResponse);

      expect(res.redirect).toHaveBeenCalledWith('/integrations/slack/error?reason=access_denied');
    });

    it('should handle generic server error', async () => {
      req.query = { code: 'test-code', state: 'test-state' };

      mockHandleCallback.mockRejectedValue(new Error('Database connection failed'));

      await handler(req as NextApiRequest, res as NextApiResponse);

      expect(res.redirect).toHaveBeenCalledWith('/integrations/slack/error?reason=server_error');
    });

    it('should use default workspace name if team name is missing', async () => {
      req.query = { code: 'test-code', state: 'test-state' };

      mockHandleCallback.mockImplementation(async (_req, _res, options) => {
        // Don't call onInstallCompleteCallback - simulates no metadata being set
        await options.success(
          {
            team: { id: 'T123' }, // No name
            bot: { userId: 'U123', token: 'xoxb-token', id: 'B123' },
            appId: 'A123',
          },
          {},
          _req,
          _res
        );
      });

      await handler(req as NextApiRequest, res as NextApiResponse);

      expect(res.redirect).toHaveBeenCalledWith('/integrations/slack/success?workspace=your+workspace');
    });
  });

  describe('Browser binding', () => {
    beforeEach(() => {
      req.query = { code: 'c', state: 's' };
    });

    const setCookies = () => [(res.getHeader as ReturnType<typeof vi.fn>)('Set-Cookie')].flat().map(String);
    const expectNonceBurnedLast = () =>
      expect(setCookies().at(-1)).toMatch(/^b4m_oauth_nonce_slack-app-install=;.*Max-Age=0/);

    it.each([
      ['the hash of the install-slot cookie', NONCE_COOKIE, COOKIE_HASH],
      ['null (never undefined) when the cookie is absent', undefined, null],
    ])('passes %s as the expected nonce hash', async (_label, cookie, expected) => {
      req.headers = { cookie };
      mockHandleCallback.mockResolvedValue(undefined);

      await handler(req as NextApiRequest, res as NextApiResponse);

      expect(mockBinding).toHaveBeenCalledWith({ expectedNonceHash: expected });
    });

    it('burns the nonce and redirects to the error page when handleCallback rejects', async () => {
      mockHandleCallback.mockRejectedValue(new Error('Invalid or expired state parameter'));

      await handler(req as NextApiRequest, res as NextApiResponse);

      expectNonceBurnedLast();
      expect(res.redirect).toHaveBeenCalledWith('/integrations/slack/error?reason=invalid_params');
    });

    it('burns the nonce when the install provider cannot be created', async () => {
      createProviderError = new Error('No Slack workspaces configured');

      await handler(req as NextApiRequest, res as NextApiResponse);

      expectNonceBurnedLast();
      expect(mockHandleCallback).not.toHaveBeenCalled();
    });

    it('keeps the nonce expiry as the final Set-Cookie even when Bolt overwrites the header', async () => {
      mockHandleCallback.mockImplementation(async () => {
        res.setHeader!('Set-Cookie', 'slack-app-oauth-state=deleted');
      });

      await handler(req as NextApiRequest, res as NextApiResponse);

      expect(setCookies()).toHaveLength(2);
      expectNonceBurnedLast();
    });
  });
});
