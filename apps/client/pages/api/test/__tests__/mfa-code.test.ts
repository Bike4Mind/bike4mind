import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({
  isE2EEnabled: vi.fn(() => true),
  isValidSecret: vi.fn((s: unknown) => s === 'right-secret'),
  findByEmail: vi.fn(),
  findByIdWithMfaSecrets: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const routes: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign((req: { method?: string }, res: unknown) => routes[req.method ?? 'GET']?.(req, res), {
      use: () => chain,
      get: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((routes.GET = fns[fns.length - 1]), chain),
    });
    return chain;
  },
}));
vi.mock('@server/middlewares/asyncHandler', () => ({
  asyncHandler: (fn: (req: unknown, res: unknown) => unknown) => fn,
}));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ isE2EEnabled: h.isE2EEnabled }));
vi.mock('@server/auth/e2eTestSecret', () => ({ isValidE2eTestSecret: h.isValidSecret }));
vi.mock('@bike4mind/database', () => ({
  userRepository: { findByEmail: h.findByEmail, findByIdWithMfaSecrets: h.findByIdWithMfaSecrets },
}));

import handler from '../mfa-code';

const SECRET = 'JBSWY3DPEHPK3PXP';
const EMAIL = 'qa-user-e2e@test.com';
// 2026-01-01T00:00:10Z, 10 s into a 30 s step.
const NOW_MS = Date.UTC(2026, 0, 1, 0, 0, 10);
const NOW_STEP = Math.floor(NOW_MS / 30_000);

// What an authenticator app shows for SECRET at NOW_STEP and the step after.
const NOW_CODE = '260025';
const NEXT_CODE = '307890';

const call = async (email: string | undefined = EMAIL, secret = 'right-secret') => {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  await handler(
    {
      method: 'GET',
      query: email === undefined ? {} : { email },
      headers: { 'x-e2e-cleanup-secret': secret },
    } as never,
    { status, json } as never
  );
  return { status, json };
};

const enrolled = (totpLastStep: number | null) => ({
  id: 'u1',
  totpLastStep,
  mfa: { totpEnabled: true, totpSecret: SECRET },
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW_MS);
  h.isE2EEnabled.mockReturnValue(true);
  h.findByEmail.mockResolvedValue({ id: 'u1' });
  h.findByIdWithMfaSecrets.mockResolvedValue(enrolled(null));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('GET /api/test/mfa-code', () => {
  it('answers 404 outside e2e-enabled stages', async () => {
    h.isE2EEnabled.mockReturnValue(false);
    const { status } = await call();
    expect(status).toHaveBeenCalledWith(404);
    expect(h.findByEmail).not.toHaveBeenCalled();
  });

  it('refuses a wrong secret', async () => {
    const { status } = await call(EMAIL, 'wrong');
    expect(status).toHaveBeenCalledWith(401);
    expect(h.findByEmail).not.toHaveBeenCalled();
  });

  it('refuses an address outside the test pattern', async () => {
    const { status } = await call('someone@example.com');
    expect(status).toHaveBeenCalledWith(400);
    expect(h.findByEmail).not.toHaveBeenCalled();
  });

  it('answers 404 for an account with no TOTP factor', async () => {
    h.findByIdWithMfaSecrets.mockResolvedValue({ id: 'u1', mfa: { totpEnabled: false } });
    const { status } = await call();
    expect(status).toHaveBeenCalledWith(404);
  });

  it("returns the current step's code when no code has been used", async () => {
    const { status, json } = await call();
    expect(status).toHaveBeenCalledWith(200);
    expect(json).toHaveBeenCalledWith({ code: NOW_CODE, step: NOW_STEP });
  });

  it('returns the code after the last accepted step', async () => {
    h.findByIdWithMfaSecrets.mockResolvedValue(enrolled(NOW_STEP));
    const { json } = await call();
    expect(json).toHaveBeenCalledWith({ code: NEXT_CODE, step: NOW_STEP + 1 });
  });

  it('asks the caller to wait when the next unused step is outside the verify window', async () => {
    h.findByIdWithMfaSecrets.mockResolvedValue(enrolled(NOW_STEP + 1));
    const { status, json } = await call();
    expect(status).toHaveBeenCalledWith(409);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ retryAfterMs: 20_000 }));
  });
});
