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
// In-memory stand-in for the cache counters (one fixed window, never expiring within a test).
const cache = vi.hoisted(() => {
  const counts = new Map<string, number>();
  const expiresAt = () => new Date(Date.now() + 60_000);
  return {
    counts,
    tryIncrement: async (key: string, limit: number) => {
      const count = counts.get(key) ?? 0;
      if (count + 1 > limit) return { success: false, count, expiresAt: expiresAt() };
      counts.set(key, count + 1);
      return { success: true, count: count + 1, expiresAt: expiresAt() };
    },
    peek: async (key: string) => ({ success: true, count: counts.get(key) ?? 0, expiresAt: expiresAt() }),
  };
});
const mockTryIncrement = vi.fn();
vi.mock('@bike4mind/database', () => ({
  cacheRepository: {
    tryIncrementWithinLimitFixedWindow: (...a: any[]) => mockTryIncrement(...a),
    tryAddWithinLimitFixedWindow: (key: string) => cache.peek(key),
    deleteByKey: async (key: string) => cache.counts.delete(key),
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
import { OTC_LIMITS, otcEmailKey } from '@server/utils/otcLimits';

const EMAIL = 'someone@example.com';

function makeReqRes(email: string = EMAIL, ip = '81.2.69.160') {
  const { req, res } = createMocks({ method: 'POST', headers: { 'x-real-ip': ip } });
  (req as any).body = { email };
  return { req, res };
}

const resetCache = () => {
  cache.counts.clear();
  mockTryIncrement.mockImplementation(cache.tryIncrement);
};

// Runs every recorded middleware in order, as baseApi would before the route handler.
async function runMiddleware(req: any, res: any) {
  for (const mw of wiring.uses) {
    await new Promise<void>((resolve, reject) => {
      Promise.resolve(mw(req, res, (err?: unknown) => (err ? reject(err) : resolve()))).catch(reject);
    });
  }
}

describe('/api/otc/send limiter wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetCache();
    mockIsE2EEnabled.mockReturnValue(false);
  });

  it('counts every request against the per-IP and distinct-email-per-IP limits, but not the per-email ones', async () => {
    const { req, res } = makeReqRes();
    await runMiddleware(req, res);

    const { perIpTotal, perIpDaily, perIpDistinctEmails } = OTC_LIMITS.send;
    expect(mockTryIncrement).toHaveBeenCalledWith(
      'otc-limit:send-ip-total:81.2.69.160',
      perIpTotal.limit,
      perIpTotal.windowMs
    );
    expect(mockTryIncrement).toHaveBeenCalledWith(
      'otc-limit:send-ip-daily:81.2.69.160',
      perIpDaily.limit,
      perIpDaily.windowMs
    );
    expect(mockTryIncrement).toHaveBeenCalledWith(
      'otc-limit:ip-distinct:81.2.69.160',
      perIpDistinctEmails.limit,
      perIpDistinctEmails.windowMs
    );
    expect(mockTryIncrement).not.toHaveBeenCalledWith(
      expect.stringMatching(/^otc-limit:send-email/),
      expect.anything(),
      expect.anything()
    );
  });

  it('buckets IPv6 callers by /64', async () => {
    const { req, res } = makeReqRes(EMAIL, '2a02:c7f:aa:1:1:2:3:4');
    await runMiddleware(req, res);

    expect(mockTryIncrement).toHaveBeenCalledWith(
      'otc-limit:send-ip-total:2a02:c7f:aa:1::/64',
      expect.anything(),
      expect.anything()
    );
  });

  it('refuses with a 429 error and Retry-After once a limit is spent', async () => {
    mockTryIncrement.mockResolvedValue({ success: false, count: 5, expiresAt: new Date(Date.now() + 60_000) });
    const { req, res } = makeReqRes();

    await expect(runMiddleware(req, res)).rejects.toMatchObject({ statusCode: 429 });
    expect(res.getHeader('Retry-After')).toBeDefined();
  });
});

describe('/api/otc/send per-email budget', () => {
  const VICTIM = 'victim@gmail.com';
  const ATTACKER_IP = '81.2.69.166';
  const VICTIM_IP = '81.2.69.110';
  const inboxKey = `otc-limit:send-email:${otcEmailKey(VICTIM)}`;
  const sourceKey = (ip: string) => `otc-limit:send-email-ip:${otcEmailKey(`${VICTIM}|${ip}`)}`;
  const reservedAt = new Date('2026-01-01T00:00:00.000Z');

  beforeEach(() => {
    vi.clearAllMocks();
    resetCache();
    mockIsE2EEnabled.mockReturnValue(false);
    mockConfirmReservation.mockResolvedValue(true);
    mockSendOTC.mockResolvedValue({ pendingToken: 'pending-token', nonce: 'real-nonce', code: '123456' });
  });

  async function post(email: string, ip: string) {
    const { req, res } = makeReqRes(email, ip);
    try {
      await runMiddleware(req, res);
    } catch {
      return res;
    }
    await handler(req, res);
    return res;
  }

  // Drops the short-window counters, as if the attacker waited out each 15-minute window.
  const rollShortWindows = () => {
    for (const key of [...cache.counts.keys()]) {
      if (!key.includes('-daily:')) cache.counts.delete(key);
    }
  };

  it('lets an attacker spamming one address spend only what real dispatched codes cost', async () => {
    // The cooldown admits one send in ten; the rest are refused before any code goes out.
    let attempt = 0;
    mockTryReserveSlot.mockImplementation(async () =>
      attempt++ % 10 === 0 ? { allowed: true, reservedAt } : { allowed: false, retryAfterSeconds: 20 }
    );
    for (let i = 0; i < 30; i++) await post(VICTIM, ATTACKER_IP);

    expect(mockSendOTC).toHaveBeenCalledTimes(3);
    expect(cache.counts.get(sourceKey(ATTACKER_IP))).toBe(3);
    expect(cache.counts.get(inboxKey)).toBe(3);

    mockTryReserveSlot.mockResolvedValue({ allowed: true, reservedAt });
    const victim = await post(VICTIM, VICTIM_IP);
    expect(victim._getStatusCode()).toBe(200);
  });

  it('caps one source per inbox, yet the owner still gets a code after a paced day-long attack', async () => {
    // Paced at the cooldown, so every attacker request reaches dispatch; aliases fold onto one inbox.
    mockTryReserveSlot.mockResolvedValue({ allowed: true, reservedAt });
    for (let round = 0; round < 4; round++) {
      for (let i = 0; i < OTC_LIMITS.send.perEmailPerIp.limit; i++) {
        await post(`v.i.c.t.i.m+${round}x${i}@gmail.com`, ATTACKER_IP);
      }
      rollShortWindows();
    }

    expect(mockSendOTC).toHaveBeenCalledTimes(OTC_LIMITS.send.perEmailPerIpDaily.limit);
    const attacker = await post('victim+again@gmail.com', ATTACKER_IP);
    expect(attacker._getStatusCode()).toBe(429);
    expect(attacker.getHeader('Retry-After')).toBeDefined();

    const victim = await post(VICTIM, VICTIM_IP);
    expect(victim._getStatusCode()).toBe(200);
  });

  it('refuses every source once the inbox-wide short-window ceiling is reached', async () => {
    mockTryReserveSlot.mockResolvedValue({ allowed: true, reservedAt });
    const { perEmail, perEmailPerIp } = OTC_LIMITS.send;
    for (let source = 0; source < perEmail.limit / perEmailPerIp.limit; source++) {
      for (let i = 0; i < perEmailPerIp.limit; i++) await post(VICTIM, `81.2.70.${source}`);
    }
    expect(cache.counts.get(inboxKey)).toBe(perEmail.limit);

    const res = await post(VICTIM, VICTIM_IP);
    expect(res._getStatusCode()).toBe(429);
    expect(res.getHeader('Retry-After')).toBeDefined();

    rollShortWindows();
    expect((await post(VICTIM, VICTIM_IP))._getStatusCode()).toBe(200);
  });

  it('refuses with 429 and Retry-After, without reserving or dispatching, once the budget is spent', async () => {
    cache.counts.set(sourceKey(VICTIM_IP), OTC_LIMITS.send.perEmailPerIp.limit);
    mockTryReserveSlot.mockResolvedValue({ allowed: true, reservedAt });

    const res = await post(VICTIM, VICTIM_IP);

    expect(res._getStatusCode()).toBe(429);
    expect(res.getHeader('Retry-After')).toBeDefined();
    expect(mockTryReserveSlot).not.toHaveBeenCalled();
    expect(mockSendOTC).not.toHaveBeenCalled();
  });
});

describe('/api/otc/send', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetCache();
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
