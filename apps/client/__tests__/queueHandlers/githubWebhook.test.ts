import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SQSEvent, Context } from 'aws-lambda';

// Mock dependencies before imports
vi.mock('@bike4mind/observability', () => ({
  Logger: vi.fn().mockImplementation(function () {
    return {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      updateMetadata: vi.fn(),
      withMetadata: vi.fn().mockReturnThis(),
    };
  }),
}));

vi.mock('@bike4mind/database', () => ({
  connectDB: vi.fn().mockResolvedValue(undefined),
  mcpServerRepository: {
    findById: vi.fn(),
    updateGitHubWebhookLastDelivery: vi.fn(),
  },
  cacheRepository: {
    findByKey: vi.fn(),
    createOrUpdate: vi.fn(),
  },
  webhookAuditLogRepository: {
    updateByDeliveryId: vi.fn().mockResolvedValue(null),
  },
}));

vi.mock('@server/utils/config', () => ({
  Config: {
    MONGODB_URI: 'mongodb://localhost:27017/test-%STAGE%',
    STAGE: 'test',
  },
}));

// Use vi.hoisted to define mock before vi.mock hoisting
const { mockHandler } = vi.hoisted(() => ({
  mockHandler: {
    handle: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@server/integrations/github/handlers', () => ({
  createHandlerRegistry: vi.fn().mockReturnValue({}),
  getHandler: vi.fn().mockReturnValue(mockHandler),
}));

vi.mock('@server/utils/warmer', () => ({
  handleWarmerInvocation: vi.fn().mockReturnValue(false),
}));

// Import after mocking
import { dispatch } from '@server/queueHandlers/githubWebhook';
import { mcpServerRepository, cacheRepository } from '@bike4mind/database';
import { getHandler } from '@server/integrations/github/handlers';

describe('GitHub Webhook Queue Handler', () => {
  const createSQSEvent = (body: Record<string, unknown>): SQSEvent => ({
    Records: [
      {
        messageId: 'test-message-id',
        receiptHandle: 'test-receipt-handle',
        body: JSON.stringify(body),
        attributes: {
          ApproximateReceiveCount: '1',
          SentTimestamp: '1234567890',
          SenderId: 'test-sender',
          ApproximateFirstReceiveTimestamp: '1234567890',
        },
        messageAttributes: {},
        md5OfBody: 'test-md5',
        eventSource: 'aws:sqs',
        eventSourceARN: 'arn:aws:sqs:us-east-2:123456789:test-queue',
        awsRegion: 'us-east-2',
      },
    ],
  });

  const mockContext: Context = {
    callbackWaitsForEmptyEventLoop: false,
    functionName: 'test-function',
    functionVersion: '1',
    invokedFunctionArn: 'arn:aws:lambda:us-east-2:123456789:function:test',
    memoryLimitInMB: '128',
    awsRequestId: 'test-request-id',
    logGroupName: '/aws/lambda/test',
    logStreamName: 'test-stream',
    getRemainingTimeInMillis: () => 60000,
    done: vi.fn(),
    fail: vi.fn(),
    succeed: vi.fn(),
  };

  const validPayload = {
    deliveryId: 'test-delivery-123',
    eventType: 'push',
    payload: { action: 'opened', repository: { full_name: 'owner/repo' } },
    mcpServerId: 'mcp-server-id',
    userId: 'user-id',
    receivedAt: new Date().toISOString(),
    correlationId: 'test-correlation-id',
  };

  const mockMcpServer = {
    id: 'mcp-server-id',
    userId: 'user-id',
    name: 'github' as const,
    enabled: true,
    envVariables: [],
    tools: [],
    metadata: {
      webhooks: {
        github: {
          routingToken: 'test-token',
          secret: 'test-secret',
          subscribedEvents: ['push'],
          repos: ['owner/repo'],
          createdAt: new Date().toISOString(),
        },
      },
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();

    // Default mocks
    vi.mocked(mcpServerRepository.findById).mockResolvedValue(mockMcpServer as never);
    vi.mocked(cacheRepository.findByKey).mockResolvedValue(null);
    vi.mocked(cacheRepository.createOrUpdate).mockResolvedValue(undefined as never);
    vi.mocked(mcpServerRepository.updateGitHubWebhookLastDelivery).mockResolvedValue(null);
  });

  describe('Event processing', () => {
    it('should process valid webhook event', async () => {
      const event = createSQSEvent(validPayload);

      await dispatch(event, mockContext);

      expect(mcpServerRepository.findById).toHaveBeenCalledWith('mcp-server-id');
      expect(mockHandler.handle).toHaveBeenCalledWith(validPayload.payload, mockMcpServer);
      expect(cacheRepository.createOrUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          key: 'github-webhook-processed-test-delivery-123',
        })
      );
      expect(mcpServerRepository.updateGitHubWebhookLastDelivery).toHaveBeenCalledWith('mcp-server-id');
    });

    it('should skip already processed events (idempotency)', async () => {
      vi.mocked(cacheRepository.findByKey).mockResolvedValue({
        key: 'github-webhook-processed-test-delivery-123',
        result: { processedAt: new Date().toISOString(), eventType: 'push' },
        expiresAt: new Date(Date.now() + 3600000), // 1 hour in the future
      } as never);

      const event = createSQSEvent(validPayload);

      await dispatch(event, mockContext);

      // Should not process the event
      expect(mcpServerRepository.findById).not.toHaveBeenCalled();
      expect(mockHandler.handle).not.toHaveBeenCalled();
    });

    it('should process if cache entry is expired', async () => {
      vi.mocked(cacheRepository.findByKey).mockResolvedValue({
        key: 'github-webhook-processed-test-delivery-123',
        result: { processedAt: new Date().toISOString(), eventType: 'push' },
        expiresAt: new Date(Date.now() - 1000), // Expired
      } as never);

      const event = createSQSEvent(validPayload);

      await dispatch(event, mockContext);

      // Should process the event
      expect(mcpServerRepository.findById).toHaveBeenCalled();
      expect(mockHandler.handle).toHaveBeenCalled();
    });
  });

  describe('MCP server validation', () => {
    it('should skip if MCP server not found', async () => {
      vi.mocked(mcpServerRepository.findById).mockResolvedValue(null);

      const event = createSQSEvent(validPayload);

      await dispatch(event, mockContext);

      expect(mcpServerRepository.findById).toHaveBeenCalledWith('mcp-server-id');
      expect(mockHandler.handle).not.toHaveBeenCalled();
    });
  });

  describe('Event type validation', () => {
    it('should skip handler execution but mark as processed for unsupported events', async () => {
      vi.mocked(getHandler).mockReturnValue(undefined);

      const event = createSQSEvent(validPayload);

      await dispatch(event, mockContext);

      // Should not call the handler
      expect(mockHandler.handle).not.toHaveBeenCalled();
      // But should still mark as processed to prevent SQS retry
      expect(cacheRepository.createOrUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          key: 'github-webhook-processed-test-delivery-123',
        })
      );
    });

    it('should skip handler when no handler registered for event type', async () => {
      vi.mocked(getHandler).mockReturnValue(undefined);

      const event = createSQSEvent(validPayload);

      await dispatch(event, mockContext);

      expect(mockHandler.handle).not.toHaveBeenCalled();
      // Should still update lastDeliveryAt
      expect(mcpServerRepository.updateGitHubWebhookLastDelivery).toHaveBeenCalledWith('mcp-server-id');
    });
  });

  describe('Payload validation', () => {
    it('should throw for invalid payload schema', async () => {
      const invalidPayload = {
        deliveryId: 'test-delivery',
        // Missing required fields
      };

      const event = createSQSEvent(invalidPayload);

      await expect(dispatch(event, mockContext)).rejects.toThrow();
    });
  });
});
