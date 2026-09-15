import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

// Middleware is stripped so the handler body runs directly (same pattern as verify.test.ts).
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain: any = { use: () => chain, post: (fn: any) => fn };
    return chain;
  },
}));
vi.mock('@server/middlewares/checkBlockedIP', () => ({
  checkBlockedIP: () => (_req: any, _res: any, next: any) => next?.(),
}));
vi.mock('@server/middlewares/rateLimit', () => ({ rateLimit: () => (_req: any, _res: any, next: any) => next?.() }));
vi.mock('@server/utils/eventBus', () => ({ EmailEvents: { Send: { publish: vi.fn(() => Promise.resolve()) } } }));
vi.mock('@server/utils/mailer/emailHelpers', () => ({ getLogoUrl: () => undefined }));
vi.mock('jsonwebtoken', () => ({ default: { sign: () => 'signed-pending-token' } }));

const mockIsE2EEnabled = vi.fn();
vi.mock('@server/utils/config', () => ({
  Config: { JWT_SECRET: 'test-secret' },
  isE2EEnabled: () => mockIsE2EEnabled(),
}));

const mockTryReserveSlot = vi.fn();
const mockConfirmReservation = vi.fn();
vi.mock('@bike4mind/database', () => ({
  pendingOtcTokenRepository: {
    tryReserveSlot: (...a: any[]) => mockTryReserveSlot(...a),
    confirmReservation: (...a: any[]) => mockConfirmReservation(...a),
  },
}));

const mockSendOTC = vi.fn();
vi.mock('@bike4mind/services', () => ({
  userService: { sendOTC: (...a: any[]) => mockSendOTC(...a) },
}));

import handler from '@pages/api/otc/send';

const EMAIL = 'someone@example.com';

function makeReqRes(email: string = EMAIL) {
  const { req, res } = createMocks({ method: 'POST' });
  (req as any).body = { email };
  return { req, res };
}

describe('/api/otc/send', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsE2EEnabled.mockReturnValue(false);
    mockSendOTC.mockResolvedValue({ pendingToken: 'pending-token', nonce: 'real-nonce', code: '123456' });
  });

  it('passes cooldownMs 0 to tryReserveSlot when E2E is enabled, and the prod cooldown otherwise', async () => {
    mockIsE2EEnabled.mockReturnValue(true);
    mockTryReserveSlot.mockResolvedValue({ allowed: true, reservedAt: new Date('2026-01-01T00:00:00.000Z') });
    mockConfirmReservation.mockResolvedValue(true);
    const { req, res } = makeReqRes();

    await handler(req, res);

    expect(mockTryReserveSlot).toHaveBeenCalledWith(EMAIL, 0);
  });

  it('enforces the 30s prod cooldown when E2E is not enabled', async () => {
    mockTryReserveSlot.mockResolvedValue({ allowed: true, reservedAt: new Date('2026-01-01T00:00:00.000Z') });
    mockConfirmReservation.mockResolvedValue(true);
    const { req, res } = makeReqRes();

    await handler(req, res);

    expect(mockTryReserveSlot).toHaveBeenCalledWith(EMAIL, 30 * 1000);
  });

  it('returns 429 with Retry-After when the reservation is not allowed', async () => {
    mockTryReserveSlot.mockResolvedValue({ allowed: false, retryAfterSeconds: 12 });
    const { req, res } = makeReqRes();

    await handler(req, res);

    expect(res._getStatusCode()).toBe(429);
    expect(res.getHeader('Retry-After')).toBe('12');
    expect(mockSendOTC).not.toHaveBeenCalled();
  });

  it('never returns 200 with a pendingToken when confirmReservation loses the race', async () => {
    // A newer concurrent request for the same email superseded this reservation
    // before this one could persist its nonce - this token would never verify.
    mockTryReserveSlot.mockResolvedValue({ allowed: true, reservedAt: new Date('2026-01-01T00:00:00.000Z') });
    mockConfirmReservation.mockResolvedValue(false);
    const { req, res } = makeReqRes();

    await handler(req, res);

    expect(res._getStatusCode()).toBe(429);
    expect(res._getJSONData()).not.toHaveProperty('pendingToken');
  });

  it('confirms the reservation with the real nonce and returns 200 on the happy path', async () => {
    const reservedAt = new Date('2026-01-01T00:00:00.000Z');
    mockTryReserveSlot.mockResolvedValue({ allowed: true, reservedAt });
    mockConfirmReservation.mockResolvedValue(true);
    const { req, res } = makeReqRes();

    await handler(req, res);

    expect(mockConfirmReservation).toHaveBeenCalledWith(EMAIL, reservedAt, 'real-nonce', undefined);
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ pendingToken: 'pending-token' });
  });

  it('persists the plaintext debugCode only when E2E is enabled', async () => {
    mockIsE2EEnabled.mockReturnValue(true);
    const reservedAt = new Date('2026-01-01T00:00:00.000Z');
    mockTryReserveSlot.mockResolvedValue({ allowed: true, reservedAt });
    mockConfirmReservation.mockResolvedValue(true);
    const { req, res } = makeReqRes();

    await handler(req, res);

    expect(mockConfirmReservation).toHaveBeenCalledWith(EMAIL, reservedAt, 'real-nonce', '123456');
  });
});
