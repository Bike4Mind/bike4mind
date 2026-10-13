import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomInt } from 'crypto';
import bcrypt from 'bcryptjs';
import { sendOTC, OTC_CODE_LENGTH, OTC_EXPIRY_MS } from './sendOTC';

vi.mock('crypto', async importOriginal => {
  const actual = await importOriginal<typeof import('crypto')>();
  return { ...actual, randomInt: vi.fn(actual.randomInt) };
});

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

  it('sends an email with an 8-digit code and returns that same code (for non-prod debug storage)', async () => {
    const { adapters, mocks } = makeAdapters();
    const result = await sendOTC({ email: 'test@example.com' }, adapters);
    expect(OTC_CODE_LENGTH).toBe(8);
    expect(mocks.sendOTCEmail).toHaveBeenCalledOnce();
    const [, code] = mocks.sendOTCEmail.mock.calls[0];
    expect(code).toMatch(/^\d{8}$/);
    // result.code must equal the emailed code so the route can persist it for otc-code
    expect(result.code).toBe(code);
  });

  it('draws the code from the full 8-digit space and zero-pads it', async () => {
    vi.mocked(randomInt).mockImplementationOnce((() => 42) as unknown as typeof randomInt);
    const { adapters, mocks } = makeAdapters();
    await sendOTC({ email: 'test@example.com' }, adapters);
    expect(randomInt).toHaveBeenCalledWith(0, 100_000_000);
    expect(mocks.sendOTCEmail).toHaveBeenCalledWith('test@example.com', '00000042');
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

  // The per-address verify budget relies on this: findByEmail's collation folds these variants onto
  // the plain address, so issuing a token for one would give it a separate guess budget.
  it.each([
    ['zero-width space', 'vic\u200btim@example.com'],
    ['zero-width joiner', 'victim\u200d@example.com'],
    ['fullwidth letter', 'vic\uff54im@example.com'],
  ])('issues no code for an address with a %s', async (_label, email) => {
    const { adapters, mocks } = makeAdapters();
    await expect(sendOTC({ email }, adapters)).rejects.toThrow();
    expect(mocks.sendOTCEmail).not.toHaveBeenCalled();
    expect(mocks.signPendingToken).not.toHaveBeenCalled();
  });

  it('signs pending token with correct payload shape including jti', async () => {
    const { adapters, mocks } = makeAdapters();
    await sendOTC({ email: 'test@example.com' }, adapters);
    expect(mocks.signPendingToken).toHaveBeenCalledWith({
      email: 'test@example.com',
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

  it('pending token carries no code material', async () => {
    const { adapters, mocks } = makeAdapters();
    const result = await sendOTC({ email: 'test@example.com' }, adapters);
    const payload = mocks.signPendingToken.mock.calls[0][0];
    expect(Object.keys(payload).sort()).toEqual(['attempts', 'email', 'exp', 'jti']);
    expect(JSON.stringify(payload)).not.toContain(result.code);
    expect(JSON.stringify(payload)).not.toContain(result.otcHash);
  });

  it('returns the code hash bound to the token nonce for server-side storage', async () => {
    const { adapters, mocks } = makeAdapters();
    const result = await sendOTC({ email: 'test@example.com' }, adapters);
    expect(mocks.signPendingToken.mock.calls[0][0].jti).toBe(result.nonce);
    expect(await bcrypt.compare(result.code, result.otcHash)).toBe(true);
  });
});
