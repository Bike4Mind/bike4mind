import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import { buildSignedWebhookHeaders } from './signedWebhook';

describe('buildSignedWebhookHeaders', () => {
  const secret = 'whsec_test_secret';
  const body = JSON.stringify({ id: 'quest-1', status: 'done' });

  it('signs "<timestamp>.<body>" with HMAC-SHA256 and sets every expected header', () => {
    const timestampSeconds = 1_700_000_000;

    const headers = buildSignedWebhookHeaders({
      secret,
      body,
      eventId: 'quest_quest-1',
      deliveryId: 'delivery-1',
      eventType: 'quest.settled',
      timestampSeconds,
    });

    const expectedSignature = crypto.createHmac('sha256', secret).update(`${timestampSeconds}.${body}`).digest('hex');

    expect(headers).toEqual({
      'Content-Type': 'application/json',
      'X-Webhook-Event-ID': 'quest_quest-1',
      'X-Webhook-Delivery-ID': 'delivery-1',
      'X-Webhook-Timestamp': String(timestampSeconds),
      'X-Webhook-Signature-256': `sha256=${expectedSignature}`,
      'X-Event-Type': 'quest.settled',
      'User-Agent': 'Lumina5-Webhook/1.0',
    });
  });

  it('respects a fixed timestampSeconds instead of the current time', () => {
    const timestampSeconds = 12345;

    const headers = buildSignedWebhookHeaders({
      secret,
      body,
      eventId: 'e',
      deliveryId: 'd',
      eventType: 'quest.settled',
      timestampSeconds,
    });

    expect(headers['X-Webhook-Timestamp']).toBe('12345');
  });

  it('falls back to the current time in seconds when timestampSeconds is omitted', () => {
    const before = Math.floor(Date.now() / 1000);

    const headers = buildSignedWebhookHeaders({
      secret,
      body,
      eventId: 'e',
      deliveryId: 'd',
      eventType: 'quest.settled',
    });

    const after = Math.floor(Date.now() / 1000);
    const timestamp = Number(headers['X-Webhook-Timestamp']);
    expect(timestamp).toBeGreaterThanOrEqual(before);
    expect(timestamp).toBeLessThanOrEqual(after);
  });

  it('produces a different signature when the body changes under the same secret and timestamp', () => {
    const timestampSeconds = 1_700_000_000;

    const headersA = buildSignedWebhookHeaders({
      secret,
      body,
      eventId: 'e',
      deliveryId: 'd',
      eventType: 't',
      timestampSeconds,
    });
    const headersB = buildSignedWebhookHeaders({
      secret,
      body: body.replace('done', 'error'),
      eventId: 'e',
      deliveryId: 'd',
      eventType: 't',
      timestampSeconds,
    });

    expect(headersA['X-Webhook-Signature-256']).not.toBe(headersB['X-Webhook-Signature-256']);
  });

  it('produces a different signature when the secret changes under the same body and timestamp', () => {
    const timestampSeconds = 1_700_000_000;

    const headersA = buildSignedWebhookHeaders({
      secret,
      body,
      eventId: 'e',
      deliveryId: 'd',
      eventType: 't',
      timestampSeconds,
    });
    const headersB = buildSignedWebhookHeaders({
      secret: 'whsec_other_secret',
      body,
      eventId: 'e',
      deliveryId: 'd',
      eventType: 't',
      timestampSeconds,
    });

    expect(headersA['X-Webhook-Signature-256']).not.toBe(headersB['X-Webhook-Signature-256']);
  });
});
