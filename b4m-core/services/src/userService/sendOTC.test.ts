import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sendOTC, OTC_EXPIRY_MS } from './sendOTC';

const makeAdapters = () => {
  const sendOTCEmail = vi.fn().mockResolvedValue(undefined);
  const signPendingToken = vi.fn().mockReturnValue('signed-token');

  return {
    adapters: {
      mailer: { sendOTCEmail },
      signPendingToken,
    },
    mocks: { sendOTCEmail, signPendingToken },
  };
};

describe('sendOTC', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('always returns a pendingToken and nonce regardless of user existence', async () => {
    const { adapters } = makeAdapters();
    const result = await sendOTC({ email: 'new@example.com' }, adapters);
    expect(result).toHaveProperty('pendingToken');
    expect(result.pendingToken).toBe('signed-token');
    expect(result).toHaveProperty('nonce');
    expect(result.nonce).toMatch(/^[0-9a-f-]+$/i); // UUID format
    // Must NOT have userExists property (enumeration prevention)
    expect(result).not.toHaveProperty('userExists');
  });

  it('sends an email with a 6-digit code and returns that same code (for non-prod debug storage)', async () => {
    const { adapters, mocks } = makeAdapters();
    const result = await sendOTC({ email: 'test@example.com' }, adapters);
    expect(mocks.sendOTCEmail).toHaveBeenCalledOnce();
    const [, code] = mocks.sendOTCEmail.mock.calls[0];
    expect(code).toMatch(/^\d{6}$/);
    // result.code must equal the emailed code so the route can persist it for otc-code
    expect(result.code).toBe(code);
  });

  it('normalizes email to lowercase', async () => {
    const { adapters, mocks } = makeAdapters();
    await sendOTC({ email: 'Test@EXAMPLE.com' }, adapters);
    expect(mocks.sendOTCEmail).toHaveBeenCalledWith('test@example.com', expect.any(String));
  });

  it('rejects invalid email format', async () => {
    const { adapters } = makeAdapters();
    await expect(sendOTC({ email: 'not-an-email' }, adapters)).rejects.toThrow();
  });

  it('signs pending token with correct payload shape including jti', async () => {
    const { adapters, mocks } = makeAdapters();
    await sendOTC({ email: 'test@example.com' }, adapters);
    expect(mocks.signPendingToken).toHaveBeenCalledWith({
      email: 'test@example.com',
      otcHash: expect.any(String),
      attempts: 0,
      exp: expect.any(Number),
      jti: expect.any(String),
    });
    // exp should be ~10 minutes from now
    const payload = mocks.signPendingToken.mock.calls[0][0];
    const expMs = payload.exp * 1000;
    expect(expMs).toBeGreaterThan(Date.now());
    expect(expMs).toBeLessThanOrEqual(Date.now() + OTC_EXPIRY_MS + 1000);
    // jti should be a UUID
    expect(payload.jti).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/i);
  });
});
