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
let onInstallCompleteCallback:
  | ((metadata: { isReinstall: boolean; teamName: string; teamId: string }) => void)
  | undefined;

vi.mock('@bike4mind/slack', () => ({
  createInstallProvider: (
    onInstallComplete?: (metadata: { isReinstall: boolean; teamName: string; teamId: string }) => void
  ) => {
    onInstallCompleteCallback = onInstallComplete;
    return {
      handleCallback: mockHandleCallback,
    };
  },
}));

import handler from '@pages/api/slack/oauth/callback';

describe('Slack OAuth Callback', () => {
  let req: Partial<NextApiRequest>;
  let res: Partial<NextApiResponse>;

  beforeEach(() => {
    req = {
      method: 'GET',
      query: {},
    };

    res = {
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
});
