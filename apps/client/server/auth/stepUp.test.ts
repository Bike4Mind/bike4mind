import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextFunction, Request, Response } from 'express';

const { mockFindBySid, mockMarkStepUp, mockCountPasskeys } = vi.hoisted(() => ({
  mockFindBySid: vi.fn(),
  mockMarkStepUp: vi.fn(),
  mockCountPasskeys: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  authSessionRepository: { findBySid: mockFindBySid, markStepUp: mockMarkStepUp },
  passkeyCredentialRepository: { countByUser: mockCountPasskeys },
}));
vi.mock('@bike4mind/services', () => ({
  mfaService: { userHasMFAConfigured: (user: { mfa?: { totpEnabled?: boolean } }) => !!user.mfa?.totpEnabled },
}));

import { STEP_UP_WINDOW_MS, getStepUpUntil, markStepUp, requireStepUp, stepUpGate, stepUpMethodsFor } from './stepUp';

const NOW = new Date('2026-10-14T12:00:00Z');
const session = (o: Record<string, unknown> = {}) => ({
  sid: 'sid-1',
  userId: 'user-1',
  revokedAt: null,
  expiresAt: new Date(NOW.getTime() + 86_400_000),
  stepUpAt: new Date(NOW.getTime() - 60_000),
  ...o,
});
const user = { id: 'user-1', sid: 'sid-1' };

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  mockFindBySid.mockResolvedValue(session());
  mockCountPasskeys.mockResolvedValue(0);
});

describe('getStepUpUntil / requireStepUp', () => {
  it('is satisfied by a stamp inside the window', async () => {
    const until = await getStepUpUntil(user);
    expect(until?.getTime()).toBe(NOW.getTime() - 60_000 + STEP_UP_WINDOW_MS);
    await expect(requireStepUp({ user } as Request)).resolves.toBeUndefined();
  });

  it.each([
    ['a stale stamp', session({ stepUpAt: new Date(NOW.getTime() - STEP_UP_WINDOW_MS - 1) })],
    ['no stamp', session({ stepUpAt: null })],
    ['no session row', null],
    ['a revoked session', session({ revokedAt: new Date() })],
    ['an expired session', session({ expiresAt: new Date(NOW.getTime() - 1) })],
    ["another user's session", session({ userId: 'user-2' })],
  ])('rejects %s with 403 step_up_required', async (_label, row) => {
    mockFindBySid.mockResolvedValue(row);
    expect(await getStepUpUntil(user)).toBeNull();
    await expect(requireStepUp({ user } as Request)).rejects.toMatchObject({
      statusCode: 403,
      message: 'Recent verification required',
      additionalInfo: { code: 'step_up_required' },
    });
  });

  it('rejects a request with no session id (API key, legacy token) without a lookup', async () => {
    await expect(requireStepUp({ user: { id: 'user-1' } } as Request)).rejects.toMatchObject({ statusCode: 403 });
    expect(mockFindBySid).not.toHaveBeenCalled();
  });
});

describe('stepUpGate', () => {
  const runGate = async (gate: ReturnType<typeof stepUpGate>, req: Partial<Request>) => {
    const next = vi.fn() as unknown as NextFunction & ReturnType<typeof vi.fn>;
    await gate(req as Request, {} as Response, next);
    return next;
  };

  it('passes a stepped-up request through and forwards the 403 otherwise', async () => {
    expect((await runGate(stepUpGate(), { user } as Request)).mock.calls[0]).toEqual([]);
    mockFindBySid.mockResolvedValue(session({ stepUpAt: null }));
    const next = await runGate(stepUpGate(), { user } as Request);
    expect(next.mock.calls[0][0]).toMatchObject({ statusCode: 403, additionalInfo: { code: 'step_up_required' } });
  });

  it('skips the check when the skip predicate holds', async () => {
    mockFindBySid.mockResolvedValue(null);
    const next = await runGate(stepUpGate({ skip: () => true }), { user } as Request);
    expect(next.mock.calls[0]).toEqual([]);
    expect(mockFindBySid).not.toHaveBeenCalled();
  });
});

describe('markStepUp', () => {
  it('stamps the session scoped to the user and returns the window end', async () => {
    mockMarkStepUp.mockResolvedValue(session());
    const until = await markStepUp(user, NOW);
    expect(mockMarkStepUp).toHaveBeenCalledWith('sid-1', 'user-1', NOW);
    expect(until?.getTime()).toBe(NOW.getTime() + STEP_UP_WINDOW_MS);
  });

  it('returns null without a session id or when the session is gone', async () => {
    expect(await markStepUp({ id: 'user-1' }, NOW)).toBeNull();
    mockMarkStepUp.mockResolvedValue(null);
    expect(await markStepUp(user, NOW)).toBeNull();
  });
});

describe('stepUpMethodsFor', () => {
  const asUser = (o: Record<string, unknown>) => ({ id: 'user-1', ...o }) as never;

  it('offers only the factor to an MFA-enrolled user, adding passkey when one is registered', async () => {
    const enrolled = asUser({ mfa: { totpEnabled: true }, password: 'hash', email: 'a@example.com' });
    expect(await stepUpMethodsFor(enrolled)).toEqual(['totp']);
    mockCountPasskeys.mockResolvedValue(2);
    expect(await stepUpMethodsFor(enrolled)).toEqual(['totp', 'passkey']);
  });

  it('offers password and email to a user without MFA', async () => {
    expect(await stepUpMethodsFor(asUser({ password: 'hash', email: 'a@example.com' }))).toEqual(['password', 'email']);
    expect(await stepUpMethodsFor(asUser({ email: 'a@example.com' }))).toEqual(['email']);
    expect(await stepUpMethodsFor(asUser({ mfa: { totpEnabled: false }, password: 'hash' }))).toEqual(['password']);
  });
});
