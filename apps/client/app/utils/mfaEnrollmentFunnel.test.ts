// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { reportMfaEnrollmentAbandoned } from './mfaEnrollmentFunnel';

describe('reportMfaEnrollmentAbandoned', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts an empty body with the given token, surviving navigation', () => {
    reportMfaEnrollmentAbandoned('pending-tok');

    expect(fetchMock).toHaveBeenCalledExactlyOnceWith('/api/auth/mfa/enrollment-abandoned', {
      method: 'POST',
      credentials: 'same-origin',
      keepalive: true,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer pending-tok' },
      body: '{}',
    });
  });

  it('sends nothing without a token', () => {
    reportMfaEnrollmentAbandoned(null);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('swallows a failed request', async () => {
    fetchMock.mockRejectedValue(new TypeError('keepalive not supported'));
    expect(() => reportMfaEnrollmentAbandoned('tok')).not.toThrow();
    await Promise.resolve();
  });
});
