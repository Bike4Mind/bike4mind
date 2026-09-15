import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextApiRequest, NextApiResponse } from 'next';
import crypto from 'crypto';
import handler from '@pages/api/webhooks/github';
import {
  verifyGitHubSignature,
  generateWebhookToken,
  generateWebhookSecret,
  getRawBody,
  PayloadTooLargeError,
} from '@server/integrations/github/webhookUtils';
import { isValidGitHubEventType, SUPPORTED_GITHUB_EVENTS } from '@server/integrations/github/types';

// Mock dependencies
vi.mock('@bike4mind/observability', () => ({
  Logger: vi.fn().mockImplementation(function () {
    return {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
  }),
}));

vi.mock('@bike4mind/database', () => ({
  connectDB: vi.fn().mockResolvedValue(undefined),
  mcpServerRepository: {
    findByGitHubWebhookToken: vi.fn(),
    updateGitHubWebhookLastDelivery: vi.fn(),
  },
  cacheRepository: {
    incrementCounterConditional: vi.fn(),
  },
}));

vi.mock('@server/utils/config', () => ({
  Config: {
    MONGODB_URI: 'mongodb://localhost:27017/test-%STAGE%',
    STAGE: 'test',
  },
}));

// Mock SQS utilities - use vi.hoisted to define mock before vi.mock hoisting
const { mockSendToQueue } = vi.hoisted(() => ({
  mockSendToQueue: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@server/utils/sqs', () => ({
  sendToQueue: mockSendToQueue,
}));

// Mock SST Resource
vi.mock('sst', () => ({
  Resource: {
    githubWebhookQueue: {
      url: 'https://sqs.us-east-2.amazonaws.com/123456789/test-github-webhook-queue',
    },
  },
}));

// Mock IntegrationAuditLogger
vi.mock('@server/integrations/integrationAuditLogger', () => {
  const mockLogger = {
    setUserId: vi.fn(),
    setWorkspaceId: vi.fn(),
    success: vi.fn(),
    failure: vi.fn(),
  };
  return {
    IntegrationAuditLogger: {
      create: vi.fn().mockReturnValue(mockLogger),
    },
  };
});

// Import mocked modules
import { mcpServerRepository, cacheRepository } from '@bike4mind/database';

describe('GitHub Webhook Utilities', () => {
  describe('verifyGitHubSignature', () => {
    const secret = 'test-secret';
    const payload = '{"test": "data"}';

    function createSignature(body: string, secretKey: string): string {
      return 'sha256=' + crypto.createHmac('sha256', secretKey).update(body).digest('hex');
    }

    it('should validate a correct signature', () => {
      const signature = createSignature(payload, secret);
      const result = verifyGitHubSignature(payload, signature, secret);
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should reject missing signature', () => {
      const result = verifyGitHubSignature(payload, undefined, secret);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Missing X-Hub-Signature-256 header');
    });

    it('should reject invalid signature format', () => {
      const result = verifyGitHubSignature(payload, 'invalid-format', secret);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Invalid signature format - expected sha256=<hex>');
    });

    it('should reject incorrect signature', () => {
      const wrongSignature = createSignature(payload, 'wrong-secret');
      const result = verifyGitHubSignature(payload, wrongSignature, secret);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Signature verification failed');
    });

    it('should reject signature with wrong length', () => {
      const result = verifyGitHubSignature(payload, 'sha256=tooshort', secret);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Signature length mismatch');
    });

    it('should work with Buffer payload', () => {
      const bufferPayload = Buffer.from(payload);
      const signature = createSignature(payload, secret);
      const result = verifyGitHubSignature(bufferPayload, signature, secret);
      expect(result.valid).toBe(true);
    });
  });

  describe('generateWebhookToken', () => {
    it('should generate a 64-character hex string', () => {
      const token = generateWebhookToken();
      expect(token).toMatch(/^[a-f0-9]{64}$/);
    });

    it('should generate unique tokens', () => {
      const token1 = generateWebhookToken();
      const token2 = generateWebhookToken();
      expect(token1).not.toBe(token2);
    });
  });

  describe('generateWebhookSecret', () => {
    it('should generate a 64-character hex string', () => {
      const secret = generateWebhookSecret();
      expect(secret).toMatch(/^[a-f0-9]{64}$/);
    });

    it('should generate unique secrets', () => {
      const secret1 = generateWebhookSecret();
      const secret2 = generateWebhookSecret();
      expect(secret1).not.toBe(secret2);
    });
  });

  describe('getRawBody', () => {
    it('should read body from request', async () => {
      const testData = Buffer.from('test body data');
      const mockReq = {
        on: vi.fn((event: string, callback: (data?: Buffer) => void) => {
          if (event === 'data') {
            callback(testData);
          } else if (event === 'end') {
            callback();
          }
        }),
      };

      const result = await getRawBody(mockReq);
      expect(result.toString()).toBe('test body data');
    });

    it('should reject payloads exceeding size limit', async () => {
      const largeData = Buffer.alloc(1024 * 1024 + 1); // 1MB + 1 byte
      const mockReq = {
        on: vi.fn((event: string, callback: (data?: Buffer) => void) => {
          if (event === 'data') {
            callback(largeData);
          }
        }),
      };

      await expect(getRawBody(mockReq)).rejects.toThrow(PayloadTooLargeError);
    });

    it('should accept payloads within size limit', async () => {
      const normalData = Buffer.alloc(1000); // 1KB
      const mockReq = {
        on: vi.fn((event: string, callback: (data?: Buffer) => void) => {
          if (event === 'data') {
            callback(normalData);
          } else if (event === 'end') {
            callback();
          }
        }),
      };

      const result = await getRawBody(mockReq);
      expect(result.length).toBe(1000);
    });
  });

  describe('isValidGitHubEventType', () => {
    it('should accept valid event types', () => {
      for (const eventType of SUPPORTED_GITHUB_EVENTS) {
        expect(isValidGitHubEventType(eventType)).toBe(true);
      }
    });

    it('should reject invalid event types', () => {
      expect(isValidGitHubEventType('invalid_event')).toBe(false);
      expect(isValidGitHubEventType('')).toBe(false);
      expect(isValidGitHubEventType('PUSH')).toBe(false); // case sensitive
    });
  });
});

describe('GitHub Webhook Endpoint', () => {
  let req: Partial<NextApiRequest>;
  let res: Partial<NextApiResponse>;
  const testSecret = 'test-webhook-secret';
  const testRoutingToken = 'test-routing-token';

  function createSignature(body: string): string {
    return 'sha256=' + crypto.createHmac('sha256', testSecret).update(body).digest('hex');
  }

  beforeEach(() => {
    const payload = JSON.stringify({ action: 'opened', repository: { full_name: 'owner/repo' } });

    // Create a mock request object with the on method typed correctly
    const mockOn = vi.fn((event: string, callback: (data?: Buffer | Error) => void) => {
      if (event === 'data') {
        callback(Buffer.from(payload));
      } else if (event === 'end') {
        callback();
      }
    });

    req = {
      method: 'POST',
      headers: {
        'x-github-event': 'ping',
        'x-github-delivery': 'test-delivery-123',
        'x-hub-signature-256': createSignature(payload),
        'x-webhook-token': testRoutingToken,
        'content-type': 'application/json',
      },
      on: mockOn as unknown as NextApiRequest['on'],
    };

    res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    };

    vi.clearAllMocks();

    // Reset SQS mock
    mockSendToQueue.mockResolvedValue(undefined);

    // Default mock: MCP server found with webhook config
    vi.mocked(mcpServerRepository.findByGitHubWebhookToken).mockResolvedValue({
      id: 'mcp-server-id',
      userId: 'user-id',
      name: 'github' as const,
      enabled: true,
      envVariables: [],
      tools: [],
      metadata: {
        webhooks: {
          github: {
            routingToken: testRoutingToken,
            secret: testSecret,
            subscribedEvents: ['ping'],
            repos: ['owner/repo'],
            createdAt: new Date().toISOString(),
          },
        },
      },
    } as never);

    // Default mock: Event not yet claimed
    vi.mocked(cacheRepository.incrementCounterConditional).mockResolvedValue({
      success: true,
      count: 1,
    });

    vi.mocked(mcpServerRepository.updateGitHubWebhookLastDelivery).mockResolvedValue(null);
  });

  describe('Method validation', () => {
    it('should reject non-POST requests', async () => {
      req.method = 'GET';

      await handler(req as NextApiRequest, res as NextApiResponse);

      expect(res.status).toHaveBeenCalledWith(405);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          message: 'Method not allowed',
        })
      );
    });
  });

  describe('Header validation', () => {
    it('should reject missing event type header', async () => {
      delete req.headers!['x-github-event'];

      await handler(req as NextApiRequest, res as NextApiResponse);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          message: 'Missing required headers',
        })
      );
    });

    it('should reject missing delivery ID header', async () => {
      delete req.headers!['x-github-delivery'];

      await handler(req as NextApiRequest, res as NextApiResponse);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('should reject missing routing token header', async () => {
      delete req.headers!['x-webhook-token'];

      await handler(req as NextApiRequest, res as NextApiResponse);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Missing routing token',
        })
      );
    });
  });

  describe('Authentication', () => {
    it('should return 401 for unknown routing token (prevents enumeration)', async () => {
      vi.mocked(mcpServerRepository.findByGitHubWebhookToken).mockResolvedValue(null);

      await handler(req as NextApiRequest, res as NextApiResponse);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Unauthorized',
          error: 'Invalid credentials',
        })
      );
    });

    it('should return 401 for invalid signature (same as unknown token)', async () => {
      req.headers!['x-hub-signature-256'] = 'sha256=invalid';

      await handler(req as NextApiRequest, res as NextApiResponse);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Unauthorized',
          error: 'Invalid credentials',
        })
      );
    });

    it('should return 401 for missing signature', async () => {
      delete req.headers!['x-hub-signature-256'];

      await handler(req as NextApiRequest, res as NextApiResponse);

      expect(res.status).toHaveBeenCalledWith(401);
    });
  });

  describe('Deduplication', () => {
    it('should process new events', async () => {
      vi.mocked(cacheRepository.incrementCounterConditional).mockResolvedValue({
        success: true,
        count: 1,
      });

      await handler(req as NextApiRequest, res as NextApiResponse);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          message: 'Event accepted for processing',
        })
      );
      // Verify event was enqueued
      expect(mockSendToQueue).toHaveBeenCalledWith(
        'https://sqs.us-east-2.amazonaws.com/123456789/test-github-webhook-queue',
        expect.objectContaining({
          deliveryId: 'test-delivery-123',
          eventType: 'ping',
          mcpServerId: 'mcp-server-id',
          userId: 'user-id',
        })
      );
    });

    it('should return 200 for duplicate events (idempotent)', async () => {
      vi.mocked(cacheRepository.incrementCounterConditional).mockResolvedValue({
        success: false,
        count: 1,
      });

      await handler(req as NextApiRequest, res as NextApiResponse);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          message: 'Event already processed',
        })
      );
    });
  });

  describe('Event type validation', () => {
    it('should accept valid event types', async () => {
      req.headers!['x-github-event'] = 'pull_request';

      await handler(req as NextApiRequest, res as NextApiResponse);

      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('should return 200 for unsupported event types (no retry)', async () => {
      req.headers!['x-github-event'] = 'unsupported_event';

      await handler(req as NextApiRequest, res as NextApiResponse);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          message: 'Event type not supported',
        })
      );
    });
  });

  describe('Error handling', () => {
    it('should return 500 with generic message for unexpected errors', async () => {
      vi.mocked(mcpServerRepository.findByGitHubWebhookToken).mockRejectedValue(new Error('DB error'));

      await handler(req as NextApiRequest, res as NextApiResponse);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          message: 'Internal server error',
          error: 'An unexpected error occurred',
        })
      );
    });

    it('should return 500 when queue enqueue fails', async () => {
      mockSendToQueue.mockRejectedValue(new Error('SQS error'));

      await handler(req as NextApiRequest, res as NextApiResponse);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          message: 'Failed to queue event for processing',
          error: 'Internal server error',
        })
      );
    });
  });
});
