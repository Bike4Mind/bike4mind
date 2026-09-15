/**
 * Tests for the deployed path of invokeMcpHandler: the mcpHandler Lambda is configured, so the
 * MCP child must be spawned there and never in this process.
 *
 * The local handler spawns the MCP server as a child of whatever runtime calls it, and in a
 * deployed runtime that process holds platform credentials. The fallback that used to select the
 * local handler did so by substring-matching the error text - which, on a FunctionError, is
 * written by the MCP handler and through it by the MCP server. These pin that a remote error
 * message can no longer choose the in-process path.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CircuitBreakerError } from '@bike4mind/utils';

const { mockIsMcpServerAvailable, mockLocalMcpHandler, mockGetBreaker, mockClassifyOperation, mockSend } = vi.hoisted(
  () => ({
    mockIsMcpServerAvailable: vi.fn(),
    mockLocalMcpHandler: vi.fn(),
    mockGetBreaker: vi.fn(),
    mockClassifyOperation: vi.fn(),
    mockSend: vi.fn(),
  })
);

vi.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: class {
    send = mockSend;
  },
  InvokeCommand: class {
    constructor(public input: unknown) {}
  },
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

// A configured mcpHandler: invokeMcpHandler must take the Lambda path.
vi.mock('sst', () => ({
  Resource: {
    mcpHandler: { name: 'mcp-handler-fn' },
  },
}));

vi.mock('@bike4mind/database', () => ({
  rateLimitSnapshotRepository: {
    getLatestByIntegration: vi.fn().mockResolvedValue(null),
    create: vi.fn(),
  },
  INTEGRATION_AUDIT_INTEGRATION_NAMES: ['github', 'atlassian', 'notion'],
}));

vi.mock('@server/utils/cloudwatch', () => ({
  recordRateLimitEvent: vi.fn(),
  recordCircuitBreakerRejection: vi.fn(),
}));

vi.mock('@server/integrations/integrationAuditLogger', () => ({
  IntegrationAuditLogger: {
    create: vi.fn().mockReturnValue({ success: vi.fn(), failure: vi.fn() }),
  },
}));

vi.mock('@bike4mind/common', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/common')>()),
  normalizeEndpoint: vi.fn(),
  isNearLimit: vi.fn(),
}));

// Deployed runtime, not a developer machine.
vi.stubEnv('IS_LOCAL', '');
vi.stubEnv('NODE_ENV', 'production');

import { invokeMcpHandler } from './invokeMcpHandler';

const payload = { name: 'github', action: 'callTool', toolName: 'search' } as Parameters<typeof invokeMcpHandler>[0];

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

describe('invokeMcpHandler on the deployed Lambda path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsMcpServerAvailable.mockResolvedValue({ available: true, reason: null });
    mockGetBreaker.mockReturnValue({ execute: vi.fn(async (fn: () => Promise<unknown>) => fn()) });
    mockClassifyOperation.mockReturnValue('read');
  });

  it('returns the Lambda response without touching the local handler', async () => {
    mockSend.mockResolvedValue({ Payload: encode({ result: 'ok' }) });

    await expect(invokeMcpHandler(payload)).resolves.toEqual({ result: 'ok' });
    expect(mockLocalMcpHandler).not.toHaveBeenCalled();
  });

  it.each(['ETIMEDOUT contacting api.github.com', 'connect ECONNREFUSED 127.0.0.1:443', 'Missing credentials'])(
    'surfaces a FunctionError saying %j as a plain error, spawning nothing locally',
    async errorMessage => {
      mockSend.mockResolvedValue({
        FunctionError: 'Unhandled',
        Payload: encode({ errorMessage }),
      });

      await expect(invokeMcpHandler(payload)).rejects.toThrow(`MCP handler invocation failed: ${errorMessage}`);
      expect(mockLocalMcpHandler).not.toHaveBeenCalled();
    }
  );

  it('does not fall back when the invoke itself fails', async () => {
    const transportError = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    mockSend.mockRejectedValue(transportError);

    await expect(invokeMcpHandler(payload)).rejects.toThrow('socket hang up');
    expect(mockLocalMcpHandler).not.toHaveBeenCalled();
  });

  it('reports a non-JSON error body alongside the Lambda error type', async () => {
    mockSend.mockResolvedValue({
      FunctionError: 'Unhandled',
      Payload: new TextEncoder().encode('Runtime exited with error: signal: killed'),
    });

    await expect(invokeMcpHandler(payload)).rejects.toThrow(
      'MCP handler invocation failed: Unhandled: Runtime exited with error: signal: killed'
    );
    expect(mockLocalMcpHandler).not.toHaveBeenCalled();
  });
});
