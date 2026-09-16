import { describe, it, expect } from 'vitest';
import {
  OverwatchAnalyticsEventSchema,
  OVERWATCH_ANONYMOUS_USER_ID,
  OVERWATCH_UNKNOWN_SESSION_ID,
  OVERWATCH_VISIT_EVENT,
  isAnonymousOverwatchUserId,
  isUnknownOverwatchSessionId,
} from '../overwatch';

const validBase = {
  eventId: '550e8400-e29b-41d4-a716-446655440000',
  schemaVersion: 1,
  productId: 'vibeswire',
  userId: 'user-123',
  sessionId: 'session-abc',
  event: 'article_read',
  timestamp: '2026-05-04T20:00:00.000Z',
};

describe('OverwatchAnalyticsEventSchema — referrer field', () => {
  it('accepts a valid https URL', () => {
    const result = OverwatchAnalyticsEventSchema.safeParse({
      ...validBase,
      referrer: 'https://google.com/search?q=test',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a valid http URL', () => {
    const result = OverwatchAnalyticsEventSchema.safeParse({
      ...validBase,
      referrer: 'http://example.com',
    });
    expect(result.success).toBe(true);
  });

  it('accepts omitted referrer (optional)', () => {
    const result = OverwatchAnalyticsEventSchema.safeParse(validBase);
    expect(result.success).toBe(true);
  });

  it('rejects a bare domain without scheme', () => {
    const result = OverwatchAnalyticsEventSchema.safeParse({
      ...validBase,
      referrer: 'google.com',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a relative path', () => {
    const result = OverwatchAnalyticsEventSchema.safeParse({
      ...validBase,
      referrer: '/relative/path',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a garbage string', () => {
    const result = OverwatchAnalyticsEventSchema.safeParse({
      ...validBase,
      referrer: 'not a url at all',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a javascript: URI', () => {
    const result = OverwatchAnalyticsEventSchema.safeParse({
      ...validBase,
      referrer: 'javascript:alert(1)',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a data: URI', () => {
    const result = OverwatchAnalyticsEventSchema.safeParse({
      ...validBase,
      referrer: 'data:text/html,<script>alert(1)</script>',
    });
    expect(result.success).toBe(false);
  });
});

describe('session and identity conventions', () => {
  // The sentinels are only useful if the schema they travel in accepts them. Both are
  // colon-namespaced strings, which nothing in the field definitions forbids today - these
  // cases are what would fail if a future tightening (a uuid() on sessionId, say) forbade
  // them, instead of the events being rejected at the ingest boundary in production.
  it('accepts a visit event carrying both sentinels', () => {
    const result = OverwatchAnalyticsEventSchema.safeParse({
      ...validBase,
      userId: OVERWATCH_ANONYMOUS_USER_ID,
      sessionId: OVERWATCH_UNKNOWN_SESSION_ID,
      event: OVERWATCH_VISIT_EVENT,
    });
    expect(result.success).toBe(true);
  });

  it('recognises each sentinel and nothing that merely resembles it', () => {
    expect(isAnonymousOverwatchUserId(OVERWATCH_ANONYMOUS_USER_ID)).toBe(true);
    expect(isUnknownOverwatchSessionId(OVERWATCH_UNKNOWN_SESSION_ID)).toBe(true);

    // A product's own id is never mistaken for one. The predicates exist so consumers can
    // exclude these buckets; a loose match would silently exclude real users or sessions.
    expect(isAnonymousOverwatchUserId('anonymous')).toBe(false);
    expect(isAnonymousOverwatchUserId('overwatch:anonymous-2')).toBe(false);
    expect(isAnonymousOverwatchUserId(OVERWATCH_UNKNOWN_SESSION_ID)).toBe(false);
    expect(isUnknownOverwatchSessionId('no-session')).toBe(false);
    expect(isUnknownOverwatchSessionId(OVERWATCH_ANONYMOUS_USER_ID)).toBe(false);
  });
});
