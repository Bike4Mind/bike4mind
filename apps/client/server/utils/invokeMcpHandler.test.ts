/**
 * Tests for invokeMcpHandler circuit breaker integration: DB-backed check
 * blocking unhealthy integrations, in-memory breaker wrapping calls, and
 * CircuitBreakerError converted to a user-friendly message.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CircuitBreakerError } from '@bike4mind/utils';

// Hoisted mocks
const {
  mockIsMcpServerAvailable,
  mockLocalMcpHandler,
  mockGetBreaker,
  mockClassifyOperation,
  mockRecordCircuitBreakerRejection,
} = vi.hoisted(() => ({
  mockIsMcpServerAvailable: vi.fn(),
  mockLocalMcpHandler: vi.fn(),
  mockGetBreaker: vi.fn(),
  mockClassifyOperation: vi.fn(),
  mockRecordCircuitBreakerRejection: vi.fn(),
}));

vi.mock('@server/services/integrationCircuitBreaker', () => ({
  isMcpServerAvailable: mockIsMcpServerAvailable,
}));

vi.mock('@server/services/mcpCircuitBreakers', () => ({
  getBreaker: mockGetBreaker,
  classifyOperation: mockClassifyOperation,
  CircuitBreakerError,
}));

vi.mock('@server/utils/mcpCall', () => ({
  handler: mockLocalMcpHandler,
}));

vi.mock('sst', () => ({
  Resource: {
    mcpHandler: { name: '' }, // Empty name forces local handler path
  },
}));

vi.mock('@bike4mind/database', () => ({
  rateLimitSnapshotRepository: {
    getLatestByIntegration: vi.fn().mockResolvedValue(null),
    create: vi.fn(),
  },
  // invokeMcpHandler builds AUDITABLE_INTEGRATIONS from this at module load.
  INTEGRATION_AUDIT_INTEGRATION_NAMES: ['github', 'atlassian', 'slack', 'linear', 'notion', 'optihashi'],
}));

vi.mock('@server/utils/cloudwatch', () => ({
  recordRateLimitEvent: vi.fn(),
  recordCircuitBreakerRejection: mockRecordCircuitBreakerRejection,
}));

vi.mock('@server/integrations/integrationAuditLogger', () => ({
  IntegrationAuditLogger: {
    create: vi.fn().mockReturnValue({
      success: vi.fn(),
      failure: vi.fn(),
    }),
  },
}));

vi.mock('@bike4mind/common', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/common')>()),
  normalizeEndpoint: vi.fn(),
  isNearLimit: vi.fn(),
}));

// Force local mode so we don't need Lambda mocks
vi.stubEnv('IS_LOCAL', 'true');

import { invokeMcpHandler } from './invokeMcpHandler';

// Mock breaker whose execute() runs the given function
function createMockBreaker() {
  return {
    execute: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  };
}

// Mock breaker whose execute() rejects with CircuitBreakerError
function createOpenBreaker(name: string) {
  return {
    execute: vi.fn(async () => {
      throw new CircuitBreakerError(name, 'OPEN');
    }),
  };
}

describe('invokeMcpHandler circuit breaker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsMcpServerAvailable.mockResolvedValue({ available: true, reason: null });
    mockLocalMcpHandler.mockResolvedValue({ result: 'ok' });
    mockGetBreaker.mockReturnValue(createMockBreaker());
    mockClassifyOperation.mockReturnValue('read');
    mockRecordCircuitBreakerRejection.mockResolvedValue(undefined);
  });

  describe('DB-backed circuit breaker (Layer 1)', () => {
    it('should call the handler when integration is available', async () => {
      const payload = { name: 'github', action: 'callTool', params: {} } as Parameters<typeof invokeMcpHandler>[0];

      const result = await invokeMcpHandler(payload);

      expect(mockIsMcpServerAvailable).toHaveBeenCalledWith('github');
      expect(mockLocalMcpHandler).toHaveBeenCalledWith(payload);
      expect(result).toEqual({ result: 'ok' });
    });

    it('should throw when integration is unavailable', async () => {
      mockIsMcpServerAvailable.mockResolvedValue({
        available: false,
        reason: 'github integration is currently unavailable (3 consecutive failures). Retry later.',
      });

      const payload = { name: 'github', action: 'callTool', params: {} } as Parameters<typeof invokeMcpHandler>[0];

      await expect(invokeMcpHandler(payload)).rejects.toThrow('github integration is currently unavailable');
      expect(mockLocalMcpHandler).not.toHaveBeenCalled();
    });

    it('should throw with default message when reason is null', async () => {
      mockIsMcpServerAvailable.mockResolvedValue({ available: false, reason: null });

      const payload = { name: 'github', action: 'callTool', params: {} } as Parameters<typeof invokeMcpHandler>[0];

      await expect(invokeMcpHandler(payload)).rejects.toThrow(
        'github integration is currently unavailable. Retry later.'
      );
      expect(mockLocalMcpHandler).not.toHaveBeenCalled();
    });

    it('should skip circuit breaker check when payload has no name', async () => {
      const payload = { action: 'listTools', params: {} } as Parameters<typeof invokeMcpHandler>[0];

      await invokeMcpHandler(payload);

      expect(mockIsMcpServerAvailable).not.toHaveBeenCalled();
      expect(mockLocalMcpHandler).toHaveBeenCalled();
    });
  });

  describe('In-memory circuit breaker (Layer 2)', () => {
    it('should wrap MCP calls with breaker.execute()', async () => {
      const mockBreaker = createMockBreaker();
      mockGetBreaker.mockReturnValue(mockBreaker);

      const payload = { name: 'github', action: 'callTool', params: {} } as Parameters<typeof invokeMcpHandler>[0];

      await invokeMcpHandler(payload);

      expect(mockClassifyOperation).toHaveBeenCalledWith('callTool', undefined);
      expect(mockGetBreaker).toHaveBeenCalledWith('github', 'read');
      expect(mockBreaker.execute).toHaveBeenCalledOnce();
    });

    it('should pass "write" op type for write operations', async () => {
      mockClassifyOperation.mockReturnValue('write');
      const mockBreaker = createMockBreaker();
      mockGetBreaker.mockReturnValue(mockBreaker);

      const payload = { name: 'github', action: 'callTool', toolName: 'create_issue', params: {} } as Parameters<
        typeof invokeMcpHandler
      >[0];

      await invokeMcpHandler(payload);

      expect(mockClassifyOperation).toHaveBeenCalledWith('callTool', 'create_issue');
      expect(mockGetBreaker).toHaveBeenCalledWith('github', 'write');
    });

    it('should pass "read" op type for read operations', async () => {
      mockClassifyOperation.mockReturnValue('read');
      const mockBreaker = createMockBreaker();
      mockGetBreaker.mockReturnValue(mockBreaker);

      const payload = { name: 'github', action: 'callTool', toolName: 'get_issue', params: {} } as Parameters<
        typeof invokeMcpHandler
      >[0];

      await invokeMcpHandler(payload);

      expect(mockClassifyOperation).toHaveBeenCalledWith('callTool', 'get_issue');
      expect(mockGetBreaker).toHaveBeenCalledWith('github', 'read');
    });

    it('should convert CircuitBreakerError to user-friendly message', async () => {
      mockGetBreaker.mockReturnValue(createOpenBreaker('github'));

      const payload = { name: 'github', action: 'callTool', params: {} } as Parameters<typeof invokeMcpHandler>[0];

      await expect(invokeMcpHandler(payload)).rejects.toThrow(
        'github integration is temporarily unavailable due to repeated failures'
      );
    });

    it('should emit CloudWatch rejection metric when circuit breaker rejects', async () => {
      mockGetBreaker.mockReturnValue(createOpenBreaker('github'));

      const payload = { name: 'github', action: 'callTool', params: {} } as Parameters<typeof invokeMcpHandler>[0];

      await expect(invokeMcpHandler(payload)).rejects.toThrow();

      expect(mockRecordCircuitBreakerRejection).toHaveBeenCalledWith('github');
    });

    it('should propagate non-CircuitBreakerError errors unchanged', async () => {
      const mockBreaker = {
        execute: vi.fn(async () => {
          throw new Error('MCP handler invocation failed: 502');
        }),
      };
      mockGetBreaker.mockReturnValue(mockBreaker);

      const payload = { name: 'github', action: 'callTool', params: {} } as Parameters<typeof invokeMcpHandler>[0];

      await expect(invokeMcpHandler(payload)).rejects.toThrow('MCP handler invocation failed: 502');
    });

    it('should sequence: DB check first, then in-memory breaker', async () => {
      // DB check blocks first
      mockIsMcpServerAvailable.mockResolvedValue({
        available: false,
        reason: 'github blocked by admin',
      });
      const mockBreaker = createMockBreaker();
      mockGetBreaker.mockReturnValue(mockBreaker);

      const payload = { name: 'github', action: 'callTool', params: {} } as Parameters<typeof invokeMcpHandler>[0];

      await expect(invokeMcpHandler(payload)).rejects.toThrow('github blocked by admin');

      // In-memory breaker should never have been called
      expect(mockBreaker.execute).not.toHaveBeenCalled();
    });
  });
});
