import { describe, expect, it } from 'vitest';
import { redact } from './redact';

describe('redact', () => {
  it('strips a bearer token out of a header line', () => {
    const scrubbed = redact('Authorization: Bearer sk-live-0123456789abcdefghij');
    expect(scrubbed).not.toContain('sk-live-0123456789abcdefghij');
    expect(scrubbed).toContain('[redacted]');
  });

  it('strips a jwt wherever it appears', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    expect(redact(`sending ${jwt} upstream`)).toBe('sending [redacted] upstream');
  });

  it('strips refresh tokens and device codes named as fields', () => {
    expect(redact('refresh_token=abc123def')).toBe('refresh_token=[redacted]');
    expect(redact('device_code: WDJB-MJHT')).toBe('device_code: [redacted]');
  });

  it('leaves ordinary prose and a session uuid alone', () => {
    expect(redact('authorization header missing')).toBe('authorization header missing');
    expect(redact('token refreshed')).toBe('token refreshed');
    const uuid = '8f14e45f-ceea-467a-9c8e-3f7a1c2b4d55';
    expect(redact(`session:${uuid} started`)).toBe(`session:${uuid} started`);
  });
});
