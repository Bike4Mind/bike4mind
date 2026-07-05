import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import {
  verifyJiraSignature,
  generateRoutingToken,
  generateWebhookSecret,
  getRawBody,
  PayloadTooLargeError,
  isSupportedJiraEvent,
} from './webhookUtils';

// Signature Verification

describe('verifyJiraSignature', () => {
  const SECRET = 'test-webhook-secret';
  const PAYLOAD = '{"webhookEvent":"jira:issue_created","issue":{"key":"PROJ-1"}}';

  function computeSignature(payload: string, secret: string): string {
    return 'sha256=' + crypto.createHmac('sha256', secret).update(payload).digest('hex');
  }

  it('should accept a valid signature', () => {
    const signature = computeSignature(PAYLOAD, SECRET);
    const result = verifyJiraSignature(PAYLOAD, signature, SECRET);

    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('should accept a valid signature from Buffer payload', () => {
    const buffer = Buffer.from(PAYLOAD);
    const signature = computeSignature(PAYLOAD, SECRET);
    const result = verifyJiraSignature(buffer, signature, SECRET);

    expect(result.valid).toBe(true);
  });

  it('should reject missing signature', () => {
    const result = verifyJiraSignature(PAYLOAD, undefined, SECRET);

    expect(result.valid).toBe(false);
    expect(result.error).toContain('Missing');
  });

  it('should reject empty string signature', () => {
    const result = verifyJiraSignature(PAYLOAD, '', SECRET);

    expect(result.valid).toBe(false);
  });

  it('should reject signature without sha256= prefix', () => {
    const hash = crypto.createHmac('sha256', SECRET).update(PAYLOAD).digest('hex');
    const result = verifyJiraSignature(PAYLOAD, hash, SECRET);

    expect(result.valid).toBe(false);
    expect(result.error).toContain('format');
  });

  it('should reject wrong secret', () => {
    const signature = computeSignature(PAYLOAD, 'wrong-secret');
    const result = verifyJiraSignature(PAYLOAD, signature, SECRET);

    expect(result.valid).toBe(false);
    expect(result.error).toContain('failed');
  });

  it('should reject tampered payload', () => {
    const signature = computeSignature(PAYLOAD, SECRET);
    const result = verifyJiraSignature(PAYLOAD + 'tampered', signature, SECRET);

    expect(result.valid).toBe(false);
  });

  it('should reject signature with wrong length', () => {
    const result = verifyJiraSignature(PAYLOAD, 'sha256=abc', SECRET);

    expect(result.valid).toBe(false);
    expect(result.error).toContain('length mismatch');
  });
});

// Token Generation

describe('generateRoutingToken', () => {
  it('should generate a 64-character hex string', () => {
    const token = generateRoutingToken();

    expect(token).toHaveLength(64);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('should generate unique tokens', () => {
    const token1 = generateRoutingToken();
    const token2 = generateRoutingToken();

    expect(token1).not.toBe(token2);
  });
});

describe('generateWebhookSecret', () => {
  it('should generate a 64-character hex string', () => {
    const secret = generateWebhookSecret();

    expect(secret).toHaveLength(64);
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
  });

  it('should generate unique secrets', () => {
    const secret1 = generateWebhookSecret();
    const secret2 = generateWebhookSecret();

    expect(secret1).not.toBe(secret2);
  });
});

// Raw Body Extraction

describe('getRawBody', () => {
  function createMockReq(chunks: Buffer[], emitError?: Error) {
    type EventCallback = (data?: Buffer | Error) => void;
    const listeners: Record<string, EventCallback[]> = {};

    const req = {
      on(event: string, callback: EventCallback) {
        if (!listeners[event]) listeners[event] = [];
        listeners[event].push(callback);
        return req;
      },
    };

    // Emit data async
    setTimeout(() => {
      if (emitError) {
        listeners['error']?.forEach(cb => cb(emitError));
        return;
      }
      for (const chunk of chunks) {
        listeners['data']?.forEach(cb => cb(chunk));
      }
      listeners['end']?.forEach(cb => cb());
    }, 0);

    return req;
  }

  it('should collect request body chunks into a buffer', async () => {
    const body = '{"test": true}';
    const req = createMockReq([Buffer.from(body)]);

    const result = await getRawBody(req);

    expect(result.toString('utf8')).toBe(body);
  });

  it('should concatenate multiple chunks', async () => {
    const req = createMockReq([Buffer.from('hello '), Buffer.from('world')]);

    const result = await getRawBody(req);

    expect(result.toString('utf8')).toBe('hello world');
  });

  it('should reject payload exceeding max size', async () => {
    const largeChunk = Buffer.alloc(100);
    const req = createMockReq([largeChunk]);

    await expect(getRawBody(req, 50)).rejects.toThrow(PayloadTooLargeError);
  });

  it('should propagate request errors', async () => {
    const error = new Error('Connection reset');
    const req = createMockReq([], error);

    await expect(getRawBody(req)).rejects.toThrow('Connection reset');
  });
});

// PayloadTooLargeError

describe('PayloadTooLargeError', () => {
  it('should have correct name and message', () => {
    const error = new PayloadTooLargeError(2000000);

    expect(error.name).toBe('PayloadTooLargeError');
    expect(error.message).toContain('2000000');
    expect(error).toBeInstanceOf(Error);
  });
});

// Supported Events

describe('isSupportedJiraEvent', () => {
  it('should return true for issue events', () => {
    expect(isSupportedJiraEvent('jira:issue_created')).toBe(true);
    expect(isSupportedJiraEvent('jira:issue_updated')).toBe(true);
    expect(isSupportedJiraEvent('jira:issue_deleted')).toBe(true);
  });

  it('should return true for comment events', () => {
    expect(isSupportedJiraEvent('comment_created')).toBe(true);
    expect(isSupportedJiraEvent('comment_updated')).toBe(true);
    expect(isSupportedJiraEvent('comment_deleted')).toBe(true);
  });

  it('should return true for sprint events', () => {
    expect(isSupportedJiraEvent('sprint_created')).toBe(true);
    expect(isSupportedJiraEvent('sprint_started')).toBe(true);
    expect(isSupportedJiraEvent('sprint_closed')).toBe(true);
  });

  it('should return false for unsupported events', () => {
    expect(isSupportedJiraEvent('issuelink_created')).toBe(false);
    expect(isSupportedJiraEvent('worklog_created')).toBe(false);
    expect(isSupportedJiraEvent('unknown')).toBe(false);
  });
});
