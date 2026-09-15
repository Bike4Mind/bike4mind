import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SlackAuditLogger, logSlackAudit, logSlackAuditFailure, SlackAuditContext } from './SlackAuditLogger';

// Mock the database repository
const mockCreateLog = vi.fn();

vi.mock('../di/registry', () => ({
  getSlackDb: () => ({
    slackAuditLogRepository: {
      createLog: (...args: unknown[]) => mockCreateLog(...args),
    },
  }),
}));

// Mock Logger
const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

describe('SlackAuditLogger', () => {
  const baseContext: SlackAuditContext = {
    eventType: 'event',
    slackUserId: 'U123456',
    slackTeamId: 'T123456',
    action: 'app_home_opened',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateLog.mockResolvedValue({ id: 'log123' });
  });

  describe('log creation', () => {
    it('should create audit log with success status', async () => {
      const logger = SlackAuditLogger.create(baseContext, mockLogger as any);
      logger.success();

      // Wait for async fire-and-forget
      await vi.waitFor(() => expect(mockCreateLog).toHaveBeenCalled());

      expect(mockCreateLog).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'event',
          slackUserId: 'U123456',
          slackTeamId: 'T123456',
          action: 'app_home_opened',
          success: true,
          errorMessage: undefined,
        })
      );
    });

    it('should create audit log with failure status and error message', async () => {
      const logger = SlackAuditLogger.create(baseContext, mockLogger as any);
      logger.failure('Something went wrong');

      await vi.waitFor(() => expect(mockCreateLog).toHaveBeenCalled());

      expect(mockCreateLog).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          errorMessage: 'Something went wrong',
        })
      );
    });

    it('should include user context when provided', async () => {
      const contextWithUser: SlackAuditContext = {
        ...baseContext,
        userId: 'b4m-user-123',
      };

      const logger = SlackAuditLogger.create(contextWithUser, mockLogger as any);
      logger.success();

      await vi.waitFor(() => expect(mockCreateLog).toHaveBeenCalled());

      expect(mockCreateLog).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'b4m-user-123',
        })
      );
    });

    it('should include resource context when provided', async () => {
      const logger = SlackAuditLogger.create(baseContext, mockLogger as any);
      logger.setResource('notebook', 'notebook-123');
      logger.success();

      await vi.waitFor(() => expect(mockCreateLog).toHaveBeenCalled());

      expect(mockCreateLog).toHaveBeenCalledWith(
        expect.objectContaining({
          resourceType: 'notebook',
          resourceId: 'notebook-123',
        })
      );
    });

    it('should allow setting userId after creation', async () => {
      const logger = SlackAuditLogger.create(baseContext, mockLogger as any);
      logger.setUserId('late-user-id');
      logger.success();

      await vi.waitFor(() => expect(mockCreateLog).toHaveBeenCalled());

      expect(mockCreateLog).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'late-user-id',
        })
      );
    });

    it('should include additional metadata when provided', async () => {
      const logger = SlackAuditLogger.create(baseContext, mockLogger as any);
      logger.success({ customField: 'customValue' });

      await vi.waitFor(() => expect(mockCreateLog).toHaveBeenCalled());

      expect(mockCreateLog).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            customField: 'customValue',
          }),
        })
      );
    });

    it('should track duration in milliseconds', async () => {
      const logger = SlackAuditLogger.create(baseContext, mockLogger as any);

      // Small delay to ensure durationMs > 0
      await new Promise(resolve => setTimeout(resolve, 10));

      logger.success();

      await vi.waitFor(() => expect(mockCreateLog).toHaveBeenCalled());

      expect(mockCreateLog).toHaveBeenCalledWith(
        expect.objectContaining({
          durationMs: expect.any(Number),
        })
      );

      const callArgs = mockCreateLog.mock.calls[0][0];
      expect(callArgs.durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('sensitive data redaction', () => {
    it('should redact token fields', async () => {
      const contextWithToken: SlackAuditContext = {
        ...baseContext,
        metadata: { token: 'xoxb-secret-token', normalField: 'visible' },
      };

      const logger = SlackAuditLogger.create(contextWithToken, mockLogger as any);
      logger.success();

      await vi.waitFor(() => expect(mockCreateLog).toHaveBeenCalled());

      const callArgs = mockCreateLog.mock.calls[0][0];
      expect(callArgs.metadata.token).toBe('[REDACTED]');
      expect(callArgs.metadata.normalField).toBe('visible');
    });

    it('should redact access_token fields', async () => {
      const contextWithToken: SlackAuditContext = {
        ...baseContext,
        metadata: { access_token: 'secret-access-token' },
      };

      const logger = SlackAuditLogger.create(contextWithToken, mockLogger as any);
      logger.success();

      await vi.waitFor(() => expect(mockCreateLog).toHaveBeenCalled());

      const callArgs = mockCreateLog.mock.calls[0][0];
      expect(callArgs.metadata.access_token).toBe('[REDACTED]');
    });

    it('should redact password fields', async () => {
      const contextWithPassword: SlackAuditContext = {
        ...baseContext,
        metadata: { password: 'super-secret', userPassword: 'also-secret' },
      };

      const logger = SlackAuditLogger.create(contextWithPassword, mockLogger as any);
      logger.success();

      await vi.waitFor(() => expect(mockCreateLog).toHaveBeenCalled());

      const callArgs = mockCreateLog.mock.calls[0][0];
      expect(callArgs.metadata.password).toBe('[REDACTED]');
      expect(callArgs.metadata.userPassword).toBe('[REDACTED]');
    });

    it('should redact api_key and apiKey fields', async () => {
      const contextWithApiKey: SlackAuditContext = {
        ...baseContext,
        metadata: { api_key: 'key1', apiKey: 'key2' },
      };

      const logger = SlackAuditLogger.create(contextWithApiKey, mockLogger as any);
      logger.success();

      await vi.waitFor(() => expect(mockCreateLog).toHaveBeenCalled());

      const callArgs = mockCreateLog.mock.calls[0][0];
      expect(callArgs.metadata.api_key).toBe('[REDACTED]');
      expect(callArgs.metadata.apiKey).toBe('[REDACTED]');
    });

    it('should redact authorization and cookie fields', async () => {
      const contextWithAuth: SlackAuditContext = {
        ...baseContext,
        metadata: { authorization: 'Bearer xxx', cookie: 'session=abc' },
      };

      const logger = SlackAuditLogger.create(contextWithAuth, mockLogger as any);
      logger.success();

      await vi.waitFor(() => expect(mockCreateLog).toHaveBeenCalled());

      const callArgs = mockCreateLog.mock.calls[0][0];
      expect(callArgs.metadata.authorization).toBe('[REDACTED]');
      expect(callArgs.metadata.cookie).toBe('[REDACTED]');
    });

    it('should redact nested sensitive fields', async () => {
      const contextWithNested: SlackAuditContext = {
        ...baseContext,
        metadata: {
          user: {
            name: 'John',
            credentials: {
              token: 'nested-secret',
              password: 'nested-password',
            },
          },
        },
      };

      const logger = SlackAuditLogger.create(contextWithNested, mockLogger as any);
      logger.success();

      await vi.waitFor(() => expect(mockCreateLog).toHaveBeenCalled());

      const callArgs = mockCreateLog.mock.calls[0][0];
      expect(callArgs.metadata.user.name).toBe('John');
      expect(callArgs.metadata.user.credentials.token).toBe('[REDACTED]');
      expect(callArgs.metadata.user.credentials.password).toBe('[REDACTED]');
    });

    it('should handle case-insensitive field matching', async () => {
      const contextWithMixedCase: SlackAuditContext = {
        ...baseContext,
        metadata: { TOKEN: 'uppercase', Password: 'mixed', API_KEY: 'caps' },
      };

      const logger = SlackAuditLogger.create(contextWithMixedCase, mockLogger as any);
      logger.success();

      await vi.waitFor(() => expect(mockCreateLog).toHaveBeenCalled());

      const callArgs = mockCreateLog.mock.calls[0][0];
      expect(callArgs.metadata.TOKEN).toBe('[REDACTED]');
      expect(callArgs.metadata.Password).toBe('[REDACTED]');
      expect(callArgs.metadata.API_KEY).toBe('[REDACTED]');
    });

    it('should preserve non-sensitive fields', async () => {
      const contextWithMixed: SlackAuditContext = {
        ...baseContext,
        metadata: {
          channelId: 'C123',
          userId: 'U456',
          action: 'click',
          timestamp: 12345,
        },
      };

      const logger = SlackAuditLogger.create(contextWithMixed, mockLogger as any);
      logger.success();

      await vi.waitFor(() => expect(mockCreateLog).toHaveBeenCalled());

      const callArgs = mockCreateLog.mock.calls[0][0];
      expect(callArgs.metadata.channelId).toBe('C123');
      expect(callArgs.metadata.userId).toBe('U456');
      expect(callArgs.metadata.action).toBe('click');
      expect(callArgs.metadata.timestamp).toBe(12345);
    });
  });

  describe('async behavior (fire-and-forget)', () => {
    it('should not throw when database write fails', async () => {
      mockCreateLog.mockRejectedValue(new Error('Database connection failed'));

      const logger = SlackAuditLogger.create(baseContext, mockLogger as any);

      // This should not throw
      expect(() => logger.success()).not.toThrow();

      // Wait for the async operation to complete
      await vi.waitFor(() => expect(mockLogger.error).toHaveBeenCalled());

      expect(mockLogger.error).toHaveBeenCalledWith(
        '[SlackAuditLogger] Failed to write audit log',
        expect.objectContaining({
          error: expect.any(Error),
          context: expect.objectContaining({
            eventType: 'event',
            action: 'app_home_opened',
            slackUserId: 'U123456',
          }),
        })
      );
    });

    it('should complete immediately without waiting for database', () => {
      // Make createLog hang indefinitely
      mockCreateLog.mockImplementation(() => new Promise(() => {}));

      const logger = SlackAuditLogger.create(baseContext, mockLogger as any);
      const startTime = Date.now();

      logger.success();

      const endTime = Date.now();

      // Should complete almost instantly (< 50ms) even though DB is "hanging"
      expect(endTime - startTime).toBeLessThan(50);
    });
  });

  describe('helper functions', () => {
    it('logSlackAudit should create and log success', async () => {
      logSlackAudit(baseContext);

      await vi.waitFor(() => expect(mockCreateLog).toHaveBeenCalled());

      expect(mockCreateLog).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
        })
      );
    });

    it('logSlackAuditFailure should create and log failure', async () => {
      logSlackAuditFailure(baseContext, 'Test error');

      await vi.waitFor(() => expect(mockCreateLog).toHaveBeenCalled());

      expect(mockCreateLog).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          errorMessage: 'Test error',
        })
      );
    });
  });
});
