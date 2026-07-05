import { describe, it, expect } from 'vitest';
import { OverwatchAnalyticsEventSchema } from '../overwatch';

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
