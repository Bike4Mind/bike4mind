import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IntegrationAuditLogger, IntegrationAuditContext } from './integrationAuditLogger';

const mockCreateLog = vi.fn();

vi.mock('@bike4mind/database', () => ({
  integrationAuditLogRepository: {
    createLog: (...args: unknown[]) => mockCreateLog(...args),
  },
}));

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

describe('IntegrationAuditLogger', () => {
  const baseContext: IntegrationAuditContext = {
    entityType: 'oauth',
    integrationName: 'github',
    action: 'oauth_callback',
    requestId: 'req-123',
  };

  const mockReq = {
    headers: {
      'x-forwarded-for': '1.2.3.4',
      'user-agent': 'TestAgent/1.0',
    },
    socket: { remoteAddress: '127.0.0.1' },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateLog.mockResolvedValue({ id: 'log123' });
  });

  describe('log creation', () => {
    it('should create audit log with success outcome', async () => {
      const logger = IntegrationAuditLogger.create(baseContext, mockReq as any, mockLogger as any);
      logger.success();

      await vi.waitFor(() => expect(mockCreateLog).toHaveBeenCalled());

      expect(mockCreateLog).toHaveBeenCalledWith(
        expect.objectContaining({
          entityType: 'oauth',
          integrationName: 'github',
          action: 'oauth_callback',
          requestId: 'req-123',
          outcome: 'success',
          errorCode: undefined,
          sourceIp: '1.2.3.4',
          userAgent: 'TestAgent/1.0',
        })
      );
    });

    it('should create audit log with failure outcome and error code', async () => {
      const logger = IntegrationAuditLogger.create(baseContext, mockReq as any, mockLogger as any);
      logger.failure('invalid_token');

      await vi.waitFor(() => expect(mockCreateLog).toHaveBeenCalled());

      expect(mockCreateLog).toHaveBeenCalledWith(
        expect.objectContaining({
          outcome: 'failure',
          errorCode: 'invalid_token',
        })
      );
    });

    it('should create audit log with rate_limited outcome', async () => {
      const logger = IntegrationAuditLogger.create(baseContext, mockReq as any, mockLogger as any);
      logger.rateLimited();

      await vi.waitFor(() => expect(mockCreateLog).toHaveBeenCalled());

      expect(mockCreateLog).toHaveBeenCalledWith(
        expect.objectContaining({
          outcome: 'rate_limited',
          errorCode: 'rate_limited',
        })
      );
    });

    it('should allow setting userId after creation', async () => {
      const logger = IntegrationAuditLogger.create(baseContext, mockReq as any, mockLogger as any);
      logger.setUserId('user-456');
      logger.success();

      await vi.waitFor(() => expect(mockCreateLog).toHaveBeenCalled());

      expect(mockCreateLog).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-456',
        })
      );
    });

    it('should allow setting workspaceId after creation', async () => {
      const logger = IntegrationAuditLogger.create(baseContext, mockReq as any, mockLogger as any);
      logger.setWorkspaceId('ws-789');
      logger.success();

      await vi.waitFor(() => expect(mockCreateLog).toHaveBeenCalled());

      expect(mockCreateLog).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: 'ws-789',
        })
      );
    });

    it('should include additional metadata', async () => {
      const logger = IntegrationAuditLogger.create(baseContext, mockReq as any, mockLogger as any);
      logger.success({ teamId: 'T123', scopes: 'read,write' });

      await vi.waitFor(() => expect(mockCreateLog).toHaveBeenCalled());

      expect(mockCreateLog).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            teamId: 'T123',
            scopes: 'read,write',
          }),
        })
      );
    });

    it('should track duration in milliseconds', async () => {
      const logger = IntegrationAuditLogger.create(baseContext, mockReq as any, mockLogger as any);

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

  describe('double-logging guard', () => {
    it('should only log once even if called multiple times', async () => {
      const logger = IntegrationAuditLogger.create(baseContext, mockReq as any, mockLogger as any);
      logger.success();
      logger.failure('should_not_log');
      logger.rateLimited();

      await vi.waitFor(() => expect(mockCreateLog).toHaveBeenCalled());

      // Wait a tick to ensure no additional calls are made
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(mockCreateLog).toHaveBeenCalledTimes(1);
      expect(mockCreateLog).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'success' }));
    });
  });

  describe('IP and user-agent extraction', () => {
    it('should extract the public client IP from x-forwarded-for header', async () => {
      const req = {
        headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.2', 'user-agent': 'Test' },
        socket: { remoteAddress: '127.0.0.1' },
      };

      const logger = IntegrationAuditLogger.create(baseContext, req as any, mockLogger as any);
      logger.success();

      await vi.waitFor(() => expect(mockCreateLog).toHaveBeenCalled());

      expect(mockCreateLog).toHaveBeenCalledWith(expect.objectContaining({ sourceIp: '203.0.113.7' }));
    });

    it('should ignore a spoofed private leftmost x-forwarded-for and fall back to the socket', async () => {
      // The resolver filters private/reserved leftmost x-forwarded-for values so
      // a forged `x-forwarded-for: 10.0.0.1` can no longer poison audit records.
      const req = {
        headers: { 'x-forwarded-for': '10.0.0.1', 'user-agent': 'Test' },
        socket: { remoteAddress: '203.0.113.50' },
      };

      const logger = IntegrationAuditLogger.create(baseContext, req as any, mockLogger as any);
      logger.success();

      await vi.waitFor(() => expect(mockCreateLog).toHaveBeenCalled());

      expect(mockCreateLog).toHaveBeenCalledWith(expect.objectContaining({ sourceIp: '203.0.113.50' }));
    });

    it('should fall back to socket remoteAddress when no x-forwarded-for', async () => {
      const req = {
        headers: { 'user-agent': 'Test' },
        socket: { remoteAddress: '192.168.1.1' },
      };

      const logger = IntegrationAuditLogger.create(baseContext, req as any, mockLogger as any);
      logger.success();

      await vi.waitFor(() => expect(mockCreateLog).toHaveBeenCalled());

      expect(mockCreateLog).toHaveBeenCalledWith(expect.objectContaining({ sourceIp: '192.168.1.1' }));
    });

    it('should use "unknown" when no request is provided', async () => {
      const logger = IntegrationAuditLogger.create(baseContext, undefined, mockLogger as any);
      logger.success();

      await vi.waitFor(() => expect(mockCreateLog).toHaveBeenCalled());

      expect(mockCreateLog).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceIp: 'unknown',
          userAgent: 'unknown',
        })
      );
    });
  });

  describe('sensitive data redaction', () => {
    it('should redact token fields in metadata', async () => {
      const context: IntegrationAuditContext = {
        ...baseContext,
        metadata: { token: 'secret-token', normalField: 'visible' },
      };

      const logger = IntegrationAuditLogger.create(context, mockReq as any, mockLogger as any);
      logger.success();

      await vi.waitFor(() => expect(mockCreateLog).toHaveBeenCalled());

      const callArgs = mockCreateLog.mock.calls[0][0];
      expect(callArgs.metadata.token).toBe('[REDACTED]');
      expect(callArgs.metadata.normalField).toBe('visible');
    });

    it('should redact access_token and refresh_token fields', async () => {
      const context: IntegrationAuditContext = {
        ...baseContext,
        metadata: { access_token: 'secret', refresh_token: 'also-secret' },
      };

      const logger = IntegrationAuditLogger.create(context, mockReq as any, mockLogger as any);
      logger.success();

      await vi.waitFor(() => expect(mockCreateLog).toHaveBeenCalled());

      const callArgs = mockCreateLog.mock.calls[0][0];
      expect(callArgs.metadata.access_token).toBe('[REDACTED]');
      expect(callArgs.metadata.refresh_token).toBe('[REDACTED]');
    });

    it('should redact newly added sensitive fields (private_key, credential, signing_key, passphrase)', async () => {
      const context: IntegrationAuditContext = {
        ...baseContext,
        metadata: {
          private_key: 'rsa-key',
          credential: 'cred-123',
          signing_key: 'hmac-key',
          passphrase: 'my-pass',
        },
      };

      const logger = IntegrationAuditLogger.create(context, mockReq as any, mockLogger as any);
      logger.success();

      await vi.waitFor(() => expect(mockCreateLog).toHaveBeenCalled());

      const callArgs = mockCreateLog.mock.calls[0][0];
      expect(callArgs.metadata.private_key).toBe('[REDACTED]');
      expect(callArgs.metadata.credential).toBe('[REDACTED]');
      expect(callArgs.metadata.signing_key).toBe('[REDACTED]');
      expect(callArgs.metadata.passphrase).toBe('[REDACTED]');
    });

    it('should redact nested sensitive fields', async () => {
      const context: IntegrationAuditContext = {
        ...baseContext,
        metadata: {
          user: {
            name: 'John',
            config: {
              token: 'nested-secret',
              password: 'nested-password',
            },
          },
        },
      };

      const logger = IntegrationAuditLogger.create(context, mockReq as any, mockLogger as any);
      logger.success();

      await vi.waitFor(() => expect(mockCreateLog).toHaveBeenCalled());

      const callArgs = mockCreateLog.mock.calls[0][0];
      const user = callArgs.metadata.user as Record<string, unknown>;
      expect(user.name).toBe('John');
      const config = user.config as Record<string, unknown>;
      expect(config.token).toBe('[REDACTED]');
      expect(config.password).toBe('[REDACTED]');
    });

    it('should redact entire object when parent key matches a sensitive field', async () => {
      const context: IntegrationAuditContext = {
        ...baseContext,
        metadata: {
          credentials: { user: 'admin', pass: '1234' },
        },
      };

      const logger = IntegrationAuditLogger.create(context, mockReq as any, mockLogger as any);
      logger.success();

      await vi.waitFor(() => expect(mockCreateLog).toHaveBeenCalled());

      const callArgs = mockCreateLog.mock.calls[0][0];
      expect(callArgs.metadata.credentials).toBe('[REDACTED]');
    });

    it('should redact sensitive fields inside arrays', async () => {
      const context: IntegrationAuditContext = {
        ...baseContext,
        metadata: {
          connections: [
            { name: 'conn1', token: 'secret-1' },
            { name: 'conn2', token: 'secret-2' },
          ],
        },
      };

      const logger = IntegrationAuditLogger.create(context, mockReq as any, mockLogger as any);
      logger.success();

      await vi.waitFor(() => expect(mockCreateLog).toHaveBeenCalled());

      const callArgs = mockCreateLog.mock.calls[0][0];
      const connections = callArgs.metadata.connections as Array<Record<string, unknown>>;
      expect(connections[0].name).toBe('conn1');
      expect(connections[0].token).toBe('[REDACTED]');
      expect(connections[1].name).toBe('conn2');
      expect(connections[1].token).toBe('[REDACTED]');
    });

    it('should handle case-insensitive field matching', async () => {
      const context: IntegrationAuditContext = {
        ...baseContext,
        metadata: { TOKEN: 'uppercase', Password: 'mixed', API_KEY: 'caps' },
      };

      const logger = IntegrationAuditLogger.create(context, mockReq as any, mockLogger as any);
      logger.success();

      await vi.waitFor(() => expect(mockCreateLog).toHaveBeenCalled());

      const callArgs = mockCreateLog.mock.calls[0][0];
      expect(callArgs.metadata.TOKEN).toBe('[REDACTED]');
      expect(callArgs.metadata.Password).toBe('[REDACTED]');
      expect(callArgs.metadata.API_KEY).toBe('[REDACTED]');
    });

    it('should preserve non-sensitive fields', async () => {
      const context: IntegrationAuditContext = {
        ...baseContext,
        metadata: {
          teamId: 'T123',
          eventType: 'push',
          repoName: 'my-repo',
          count: 42,
        },
      };

      const logger = IntegrationAuditLogger.create(context, mockReq as any, mockLogger as any);
      logger.success();

      await vi.waitFor(() => expect(mockCreateLog).toHaveBeenCalled());

      const callArgs = mockCreateLog.mock.calls[0][0];
      expect(callArgs.metadata.teamId).toBe('T123');
      expect(callArgs.metadata.eventType).toBe('push');
      expect(callArgs.metadata.repoName).toBe('my-repo');
      expect(callArgs.metadata.count).toBe(42);
    });
  });

  describe('async behavior (fire-and-forget)', () => {
    it('should not throw when database write fails', async () => {
      mockCreateLog.mockRejectedValue(new Error('Database connection failed'));

      const logger = IntegrationAuditLogger.create(baseContext, mockReq as any, mockLogger as any);

      expect(() => logger.success()).not.toThrow();

      await vi.waitFor(() => expect(mockLogger.error).toHaveBeenCalled());

      expect(mockLogger.error).toHaveBeenCalledWith(
        '[IntegrationAuditLogger] Failed to write audit log',
        expect.objectContaining({
          error: expect.any(Error),
          context: expect.objectContaining({
            entityType: 'oauth',
            integrationName: 'github',
            action: 'oauth_callback',
          }),
        })
      );
    });

    it('should complete immediately without waiting for database', () => {
      mockCreateLog.mockImplementation(() => new Promise(() => {}));

      const logger = IntegrationAuditLogger.create(baseContext, mockReq as any, mockLogger as any);
      const startTime = Date.now();

      logger.success();

      const endTime = Date.now();
      expect(endTime - startTime).toBeLessThan(50);
    });
  });
});
