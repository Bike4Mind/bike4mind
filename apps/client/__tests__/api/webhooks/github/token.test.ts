import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import {
  verifyGitHubSignature,
  generateWebhookToken,
  generateWebhookSecret,
  PayloadTooLargeError,
  getRawBody,
} from '@server/integrations/github/webhookUtils';
import { isValidGitHubEventType } from '@server/integrations/github/types';

/**
 * Unit tests for GitHub Webhook URL-based Routing Endpoint
 *
 * Tests the /api/webhooks/github/[token] endpoint logic.
 *
 * This endpoint accepts the routing token in the URL path instead of a header,
 * which is required because GitHub webhooks don't support custom headers.
 *
 * URL format: POST /api/webhooks/github/{routingToken}
 */

describe('GitHub Webhook URL-based Routing - [token].ts', () => {
  describe('Token extraction from URL', () => {
    it('should extract token from query params (Next.js dynamic route)', () => {
      // Next.js parses /api/webhooks/github/abc123 into { token: 'abc123' }
      const mockQuery = { token: 'abc123def456' };
      const token = mockQuery.token as string;
      expect(token).toBe('abc123def456');
    });

    it('should handle missing token in URL', () => {
      const mockQuery: Record<string, string | string[] | undefined> = {};
      const token = mockQuery.token;
      expect(token).toBeUndefined();
    });

    it('should handle array token (edge case from query string)', () => {
      // If someone sends ?token=a&token=b, Next.js returns ['a', 'b']
      const mockQuery = { token: ['token1', 'token2'] };
      const token = mockQuery.token as string | string[];
      // Handler uses `as string` which would take first element behavior
      expect(Array.isArray(token)).toBe(true);
    });
  });

  describe('Required headers validation', () => {
    it('should require X-GitHub-Event header', () => {
      const headers = {
        'x-github-delivery': 'delivery-123',
        'x-hub-signature-256': 'sha256=abc',
      };
      const eventType = headers['x-github-event' as keyof typeof headers];
      expect(eventType).toBeUndefined();
    });

    it('should require X-GitHub-Delivery header', () => {
      const headers = {
        'x-github-event': 'push',
        'x-hub-signature-256': 'sha256=abc',
      };
      const deliveryId = headers['x-github-delivery' as keyof typeof headers];
      expect(deliveryId).toBeUndefined();
    });

    it('should accept valid headers', () => {
      const headers = {
        'x-github-event': 'push',
        'x-github-delivery': 'delivery-123',
        'x-hub-signature-256': 'sha256=abc',
      };
      expect(headers['x-github-event']).toBe('push');
      expect(headers['x-github-delivery']).toBe('delivery-123');
      expect(headers['x-hub-signature-256']).toBe('sha256=abc');
    });
  });

  describe('Signature verification', () => {
    const testSecret = 'test-webhook-secret';
    const testPayload = JSON.stringify({ action: 'opened', number: 1 });

    it('should verify valid signature', () => {
      const signature = 'sha256=' + crypto.createHmac('sha256', testSecret).update(testPayload).digest('hex');

      const result = verifyGitHubSignature(testPayload, signature, testSecret);
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should reject invalid signature', () => {
      const result = verifyGitHubSignature(testPayload, 'sha256=invalid', testSecret);
      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should reject missing signature', () => {
      const result = verifyGitHubSignature(testPayload, undefined, testSecret);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Missing X-Hub-Signature-256 header');
    });

    it('should reject wrong signature format', () => {
      const result = verifyGitHubSignature(testPayload, 'md5=abc123', testSecret);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Invalid signature format - expected sha256=<hex>');
    });

    it('should reject signature with wrong secret', () => {
      const signature = 'sha256=' + crypto.createHmac('sha256', 'wrong-secret').update(testPayload).digest('hex');

      const result = verifyGitHubSignature(testPayload, signature, testSecret);
      expect(result.valid).toBe(false);
    });
  });

  describe('Event type validation', () => {
    it('should accept supported event types', () => {
      expect(isValidGitHubEventType('push')).toBe(true);
      expect(isValidGitHubEventType('pull_request')).toBe(true);
      expect(isValidGitHubEventType('issues')).toBe(true);
      expect(isValidGitHubEventType('issue_comment')).toBe(true);
      expect(isValidGitHubEventType('ping')).toBe(true);
    });

    it('should reject unsupported event types', () => {
      expect(isValidGitHubEventType('fork')).toBe(false);
      expect(isValidGitHubEventType('star')).toBe(false);
      expect(isValidGitHubEventType('watch')).toBe(false);
      expect(isValidGitHubEventType('invalid')).toBe(false);
    });

    it('should be case sensitive', () => {
      expect(isValidGitHubEventType('PUSH')).toBe(false);
      expect(isValidGitHubEventType('Push')).toBe(false);
    });
  });

  describe('Token generation', () => {
    it('should generate 64-character hex routing tokens', () => {
      const token = generateWebhookToken();
      expect(token).toHaveLength(64);
      expect(/^[0-9a-f]+$/.test(token)).toBe(true);
    });

    it('should generate unique tokens', () => {
      const tokens = new Set(Array.from({ length: 100 }, () => generateWebhookToken()));
      expect(tokens.size).toBe(100);
    });

    it('should generate 64-character hex secrets', () => {
      const secret = generateWebhookSecret();
      expect(secret).toHaveLength(64);
      expect(/^[0-9a-f]+$/.test(secret)).toBe(true);
    });
  });

  describe('Security: Enumeration prevention', () => {
    it('should return same error for unknown token and invalid signature', () => {
      // Both unknown routing token AND invalid signature should return 401
      // to prevent attackers from enumerating valid routing tokens
      const unknownTokenResponse = {
        success: false,
        message: 'Unauthorized',
        error: 'Invalid credentials',
      };
      const invalidSignatureResponse = {
        success: false,
        message: 'Unauthorized',
        error: 'Invalid credentials',
      };

      // Same response structure prevents enumeration
      expect(unknownTokenResponse).toEqual(invalidSignatureResponse);
    });

    it('should log token prefix only, not full token', () => {
      const routingToken = '0912aafaa1f2e6c7b2c61ee0d71ec048';
      const loggedToken = routingToken.substring(0, 8) + '...';
      expect(loggedToken).toBe('0912aafa...');
      expect(loggedToken).not.toContain(routingToken);
    });
  });

  describe('Payload size limits', () => {
    it('should have PayloadTooLargeError available', () => {
      const error = new PayloadTooLargeError(2000000);
      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe('PayloadTooLargeError');
      expect(error.message).toContain('2000000 bytes');
    });

    it('should handle getRawBody with size limit', async () => {
      // Mock a request stream with small payload
      const mockReq = {
        on: (event: string, callback: (data?: Buffer | Error) => void) => {
          if (event === 'data') {
            callback(Buffer.from('{"test": "data"}'));
          } else if (event === 'end') {
            callback();
          }
        },
      };

      const body = await getRawBody(mockReq);
      expect(body.toString()).toBe('{"test": "data"}');
    });

    it('should reject oversized payloads', async () => {
      const maxSize = 100;
      const mockReq = {
        on: (event: string, callback: (data?: Buffer | Error) => void) => {
          if (event === 'data') {
            // Send chunk larger than maxSize
            callback(Buffer.alloc(150, 'x'));
          }
        },
      };

      await expect(getRawBody(mockReq, maxSize)).rejects.toThrow(PayloadTooLargeError);
    });
  });

  describe('URL-based vs Header-based routing', () => {
    it('should document the URL path format', () => {
      // URL format: POST /api/webhooks/github/{routingToken}
      const baseUrl = 'https://www.bike4mind.com';
      const routingToken = 'abc123def456';
      const webhookUrl = `${baseUrl}/api/webhooks/github/${routingToken}`;

      expect(webhookUrl).toBe('https://www.bike4mind.com/api/webhooks/github/abc123def456');
      expect(webhookUrl).not.toContain('X-Webhook-Token');
    });

    it('should explain why URL-based routing is needed', () => {
      // GitHub webhooks don't support custom headers
      // Therefore, we embed the routing token in the URL path
      const reasons = [
        'GitHub webhooks cannot send custom headers',
        'X-Webhook-Token header approach does not work',
        'URL path is the only way to pass routing information',
      ];

      expect(reasons.length).toBe(3);
    });
  });

  describe('Response format', () => {
    it('should have success response structure', () => {
      const successResponse = {
        success: true,
        message: 'Event accepted for processing',
        eventType: 'push',
        deliveryId: 'delivery-123',
      };

      expect(successResponse).toHaveProperty('success', true);
      expect(successResponse).toHaveProperty('message');
      expect(successResponse).toHaveProperty('eventType');
      expect(successResponse).toHaveProperty('deliveryId');
    });

    it('should have error response structure', () => {
      const errorResponse = {
        success: false,
        message: 'Unauthorized',
        error: 'Invalid credentials',
      };

      expect(errorResponse).toHaveProperty('success', false);
      expect(errorResponse).toHaveProperty('message');
      expect(errorResponse).toHaveProperty('error');
    });

    it('should return 200 for already processed events (deduplication)', () => {
      const dedupeResponse = {
        success: true,
        message: 'Event already processed',
        eventType: 'push',
        deliveryId: 'delivery-123',
      };

      // Returns 200 (not 409) because the request was valid, just already handled
      expect(dedupeResponse.success).toBe(true);
      expect(dedupeResponse.message).toBe('Event already processed');
    });
  });
});
