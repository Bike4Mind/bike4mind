import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

// Middleware is stripped so the handler body runs directly (same pattern as verify.test.ts).
// The middleware passed to .use() is recorded so the limiter wiring can be asserted on its own.
const wiring = vi.hoisted(() => ({ uses: [] as any[] }));
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain: any = {
      use: (mw: any) => {
        wiring.uses.push(mw);
        return chain;
      },
      post: (fn: any) => fn,
    };
    return chain;
  },
}));
vi.mock('@server/middlewares/checkBlockedIP', () => ({
  checkBlockedIP: () => (_req: any, _res: any, next: any) => next?.(),
}));
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
const mockTryIncrement = vi.fn();
vi.mock('@bike4mind/database', () => ({
  cacheRepository: {
    tryIncrementWithinLimitFixedWindow: (...a: any[]) => mockTryIncrement(...a),
    deleteByKey: vi.fn(),
  },
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
import { OTC_LIMITS } from '@server/utils/otcLimits';

const EMAIL = 'someone@example.com';

function makeReqRes(email: string = EMAIL) {
  const { req, res } = createMocks({ method: 'POST' });
  (req as any).body = { email };
  return { req, res };
}

// Runs every recorded middleware in order, as baseApi would before the route handler.
async function runMiddleware(req: any, res: any) {
  for (const mw of wiring.uses) {
    await new Promise<void>((resolve, reject) => mw(req, res, (err?: unknown) => (err ? reject(err) : resolve())));
  }
}

describe('/api/otc/send limiter wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsE2EEnabled.mockReturnValue(false);
    mockTryIncrement.mockResolvedValue({ success: true, count: 1, expiresAt: new Date(Date.now() + 60_000) });
  });

  it('counts every send against the per-email, per-IP and distinct-email-per-IP limits', async () => {
    const { req, res } = makeReqRes();
    await runMiddleware(req, res);

    const emailKey = /^otc-limit:send-email:[0-9a-f]{32}$/;
    const emailDailyKey = /^otc-limit:send-email-daily:[0-9a-f]{32}$/;
    const { perEmail, perEmailDaily, perIpTotal, perIpDaily, perIpDistinctEmails } = OTC_LIMITS.send;
    expect(mockTryIncrement).toHaveBeenCalledWith(expect.stringMatching(emailKey), perEmail.limit, perEmail.windowMs);
    expect(mockTryIncrement).toHaveBeenCalledWith(
      expect.stringMatching(emailDailyKey),
      perEmailDaily.limit,
      perEmailDaily.windowMs
    );
    expect(mockTryIncrement).toHaveBeenCalledWith(
      expect.stringMatching(/^otc-limit:send-ip-total:/),
      perIpTotal.limit,
      perIpTotal.windowMs
    );
    expect(mockTryIncrement).toHaveBeenCalledWith(
      expect.stringMatching(/^otc-limit:send-ip-daily:/),
      perIpDaily.limit,
      perIpDaily.windowMs
    );
    expect(mockTryIncrement).toHaveBeenCalledWith(
      expect.stringMatching(/^otc-limit:ip-distinct:/),
      perIpDistinctEmails.limit,
      perIpDistinctEmails.windowMs
    );
  });

  it('refuses with a 429 error and Retry-After once a limit is spent', async () => {
    mockTryIncrement.mockResolvedValue({ success: false, count: 5, expiresAt: new Date(Date.now() + 60_000) });
    const { req, res } = makeReqRes();

    await expect(runMiddleware(req, res)).rejects.toMatchObject({ statusCode: 429 });
    expect(res.getHeader('Retry-After')).toBeDefined();
  });
});

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
