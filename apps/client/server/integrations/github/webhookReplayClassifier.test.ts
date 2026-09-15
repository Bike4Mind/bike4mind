import { describe, it, expect } from 'vitest';
import { classifyReplayability } from './webhookReplayClassifier';

describe('classifyReplayability', () => {
  it('skips org_notification records — they have no outbound HTTP payload by design', () => {
    expect(
      classifyReplayability({
        deliveryKind: 'org_notification',
        // even if payload/targetUrl were somehow present, kind wins (they can't be HTTP-replayed)
        payload: { foo: 'bar' },
        targetUrl: 'https://example.com',
      })
    ).toBe('notification_kind');
  });

  it('skips records with no payload as missing_payload', () => {
    expect(
      classifyReplayability({
        deliveryKind: 'outbound_http',
        targetUrl: 'https://example.com',
      })
    ).toBe('missing_payload');
  });

  it('skips records with empty payload as missing_payload', () => {
    expect(
      classifyReplayability({
        deliveryKind: 'outbound_http',
        payload: {},
        targetUrl: 'https://example.com',
      })
    ).toBe('missing_payload');
  });

  it('skips records with payload but no targetUrl as missing_target_url', () => {
    expect(
      classifyReplayability({
        deliveryKind: 'outbound_http',
        payload: { foo: 'bar' },
      })
    ).toBe('missing_target_url');
  });

  it('returns null for records ready to enqueue (payload + targetUrl, not notification)', () => {
    expect(
      classifyReplayability({
        deliveryKind: 'outbound_http',
        payload: { foo: 'bar' },
        targetUrl: 'https://example.com',
      })
    ).toBeNull();
  });

  it('treats undefined deliveryKind as outbound_http (back-compat for older records)', () => {
    // Older records pre-date the field - they should be classified by payload/targetUrl only.
    expect(
      classifyReplayability({
        payload: { foo: 'bar' },
        targetUrl: 'https://example.com',
      })
    ).toBeNull();
    expect(classifyReplayability({})).toBe('missing_payload');
  });

  it('does not classify a notification-kind record as missing_payload even when payload is absent', () => {
    // Regression guard: previously the missing-payload branch was checked first, so
    // notification records were misreported as "missing payload". The
    // notification-kind check must come first.
    expect(classifyReplayability({ deliveryKind: 'org_notification' })).toBe('notification_kind');
  });
});
