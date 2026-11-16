import { describe, expect, it } from 'vitest';
import { SessionHandoffAction, SessionHandoffRequestSchema } from './sessionHandoff';

describe('handoff payload', () => {
  const sessionId = '0123456789abcdef01234567';
  it('accepts the exact session id and destination', () => {
    expect(SessionHandoffRequestSchema.parse({ sessionId, deviceId: 'live:abc' })).toEqual({
      sessionId,
      deviceId: 'live:abc',
    });
  });
  it('refuses injected URLs, credentials, content and malformed session ids', () => {
    for (const extra of [{ deepLink: 'https://elsewhere.test' }, { accessToken: 'secret' }, { body: 'content' }]) {
      expect(SessionHandoffRequestSchema.safeParse({ sessionId, deviceId: 'x', ...extra }).success).toBe(false);
    }
    expect(SessionHandoffAction.safeParse({ action: 'session_handoff', sessionId: '../admin' }).success).toBe(false);
    expect(SessionHandoffAction.parse({ action: 'session_handoff', sessionId, body: 'ignored' })).toEqual({
      action: 'session_handoff',
      sessionId,
    });
  });
});
