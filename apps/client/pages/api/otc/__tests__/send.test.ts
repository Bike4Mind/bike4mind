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
const turnstileActions = vi.hoisted(() => [] as string[]);
const turnstileGate = vi.hoisted(() => vi.fn((_req: unknown, _res: unknown, next: () => void) => next()));
const mockCheckTurnstileToken = vi.hoisted(() => vi.fn());
vi.mock('@server/middlewares/requireTurnstile', () => ({
  requireTurnstile: (action: string) => {
    turnstileActions.push(action);
    return turnstileGate;
  },
  checkTurnstileToken: (...a: unknown[]) => mockCheckTurnstileToken(...a),
}));
const stepUpPolicy = vi.hoisted(() => ({ active: false, failClosed: false, siteKey: '', secret: '' }));
vi.mock('@server/utils/auth/turnstile', () => ({ getTurnstileStepUpPolicy: async () => ({ ...stepUpPolicy }) }));
const mockRecipientRefusal = vi.hoisted(() => vi.fn());
vi.mock('@server/utils/otcRecipient', () => ({
  otcRecipientRefusal: (...a: unknown[]) => mockRecipientRefusal(...a),
}));
vi.mock('@server/utils/eventBus', () => ({ EmailEvents: { Send: { publish: vi.fn(() => Promise.resolve()) } } }));
vi.mock('@bike4mind/server-utils/utils/mailer/emailHelpers', () => ({ getLogoUrl: () => undefined }));
vi.mock('jsonwebtoken', () => ({ default: { sign: () => 'signed-pending-token' } }));

const mockIsE2EEnabled = vi.fn();
vi.mock('@bike4mind/server-utils/utils/config', () => ({
  Config: { JWT_SECRET: 'test-secret' },
  isE2EEnabled: () => mockIsE2EEnabled(),
}));

const mockTryReserveSlot = vi.fn();
const mockConfirmReservation = vi.fn();
const mockReleaseReservation = vi.fn();
// In-memory stand-in for the cache counters (one fixed window, never expiring within a test).
const cache = vi.hoisted(() => {
  const counts = new Map<string, number>();
  const expiresAt = () => new Date(Date.now() + 60_000);
  const state = { blindPeek: false };
  return {
    counts,
    state,
    tryIncrement: async (key: string, limit: number) => {
      const count = counts.get(key) ?? 0;
      if (count + 1 > limit) return { success: false, count, expiresAt: expiresAt() };
      counts.set(key, count + 1);
      return { success: true, count: count + 1, expiresAt: expiresAt() };
    },
    // blindPeek models concurrent requests that all read the budget before any of them spends it.
    peek: async (key: string) => ({
      success: true,
      count: state.blindPeek ? 0 : (counts.get(key) ?? 0),
      expiresAt: expiresAt(),
    }),
    decrement: async (key: string) => {
      const count = (counts.get(key) ?? 0) - 1;
      counts.set(key, count);
      return count;
    },
  };
});
const mockTryIncrement = vi.fn();
const mockFindByEmail = vi.fn();
vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: { findAll: async () => [], findBySettingNames: async () => [] },
  cacheRepository: {
    tryIncrementWithinLimitFixedWindow: (...a: any[]) => mockTryIncrement(...a),
    tryAddWithinLimitFixedWindow: (key: string) => cache.peek(key),
    deleteByKey: async (key: string) => cache.counts.delete(key),
    decrementCounter: (key: string) => cache.decrement(key),
  },
  userRepository: { findByEmail: (...a: any[]) => mockFindByEmail(...a) },
  pendingOtcTokenRepository: {
    tryReserveSlot: (...a: any[]) => mockTryReserveSlot(...a),
    confirmReservation: (...a: any[]) => mockConfirmReservation(...a),
    releaseReservation: (...a: any[]) => mockReleaseReservation(...a),
  },
}));

const mockSendOTC = vi.fn();
vi.mock('@bike4mind/services', () => ({
  userService: { sendOTC: (...a: any[]) => mockSendOTC(...a) },
}));

import handler from '@pages/api/otc/send';
import { OTC_LIMITS, otcEmailKey } from '@server/utils/otcLimits';
import { EmailEvents } from '@server/utils/eventBus';

const EMAIL = 'someone@example.com';

function makeReqRes(email: string = EMAIL, ip = '81.2.69.160') {
  const { req, res } = createMocks({ method: 'POST', headers: { 'x-real-ip': ip } });
  return { req: Object.assign(req, { body: { email }, logger: { info: vi.fn(), warn: vi.fn() } }), res };
}

const resetCache = () => {
  mockRecipientRefusal.mockResolvedValue(undefined);
  mockFindByEmail.mockResolvedValue(null);
  Object.assign(stepUpPolicy, { active: false, siteKey: '', secret: '' });
  cache.counts.clear();
  cache.state.blindPeek = false;
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

  it('gates the route on the otc-send Turnstile challenge before any limiter runs', () => {
    expect(turnstileActions).toEqual(['otc-send']);
    expect(wiring.uses[1]).toBe(turnstileGate);
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
    mockSendOTC.mockResolvedValue({
      pendingToken: 'pending-token',
      nonce: 'real-nonce',
      otcHash: 'code-hash',
      code: '123456',
    });
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

  it('bounds racing alias sends that all passed the budget read', async () => {
    cache.state.blindPeek = true;
    mockTryReserveSlot.mockResolvedValue({ allowed: true, reservedAt });
    const results = [];
    for (let i = 0; i < 8; i++) results.push(await post(`victim+${i}@gmail.com`, ATTACKER_IP));

    const { perEmailPerIp } = OTC_LIMITS.send;
    expect(mockSendOTC).toHaveBeenCalledTimes(perEmailPerIp.limit);
    const refused = results.filter(r => r._getStatusCode() === 429);
    expect(refused).toHaveLength(8 - perEmailPerIp.limit);
    expect(refused.every(r => r.getHeader('Retry-After') !== undefined)).toBe(true);
    expect(cache.counts.get(inboxKey)).toBe(perEmailPerIp.limit);
  });

  it('releases the cooldown slot when the atomic budget reserve refuses after the read passed', async () => {
    cache.state.blindPeek = true;
    const previousCreatedAt = new Date('2025-12-31T23:59:00.000Z');
    mockTryReserveSlot.mockResolvedValue({ allowed: true, reservedAt, previousCreatedAt });
    cache.counts.set(sourceKey(ATTACKER_IP), OTC_LIMITS.send.perEmailPerIp.limit);

    const res = await post(VICTIM, ATTACKER_IP);

    expect(res._getStatusCode()).toBe(429);
    expect(res.getHeader('Retry-After')).toBeDefined();
    expect(mockReleaseReservation).toHaveBeenCalledWith(VICTIM, reservedAt, previousCreatedAt);
    expect(mockSendOTC).not.toHaveBeenCalled();
  });

  it('keeps the cooldown slot once a code is dispatched', async () => {
    mockTryReserveSlot.mockResolvedValue({ allowed: true, reservedAt, previousCreatedAt: null });

    expect((await post(VICTIM, VICTIM_IP))._getStatusCode()).toBe(200);
    expect(mockReleaseReservation).not.toHaveBeenCalled();
  });

  // The exact-address verify budget (see OTC_VERIFY_EMAIL_BUDGETS) depends on this refusal.
  it('issues no code for an address with a zero-width character', async () => {
    const { userService } = await vi.importActual<typeof import('@bike4mind/services')>('@bike4mind/services');
    mockSendOTC.mockImplementation((params, adapters) => userService.sendOTC(params, adapters));
    mockTryReserveSlot.mockResolvedValue({ allowed: true, reservedAt, previousCreatedAt: null });
    const { req, res } = makeReqRes('vic\u200btim@gmail.com', VICTIM_IP);

    await expect(handler(req, res)).rejects.toMatchObject({ name: 'ZodError' });

    expect(EmailEvents.Send.publish).not.toHaveBeenCalled();
    expect(mockConfirmReservation).not.toHaveBeenCalled();
    expect(res._isEndCalled()).toBe(false);
  });

  it('refunds the budget when dispatch fails', async () => {
    mockTryReserveSlot.mockResolvedValue({ allowed: true, reservedAt });
    mockSendOTC.mockRejectedValueOnce(new Error('publish failed'));
    const { req, res } = makeReqRes(VICTIM, VICTIM_IP);
    await runMiddleware(req, res);

    await expect(handler(req, res)).rejects.toThrow('publish failed');
    expect(cache.counts.get(sourceKey(VICTIM_IP))).toBe(0);
    expect(cache.counts.get(inboxKey)).toBe(0);
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
    mockSendOTC.mockResolvedValue({
      pendingToken: 'pending-token',
      nonce: 'real-nonce',
      otcHash: 'code-hash',
      code: '123456',
    });
  });

  const dispatchThroughMailer = () => {
    mockSendOTC.mockImplementation(
      async (
        _params: unknown,
        adapters: { mailer: { sendOTCEmail: (email: string, code: string) => Promise<void> } }
      ) => {
        await adapters.mailer.sendOTCEmail(EMAIL, '123456');
        return { pendingToken: 'pending-token', nonce: 'real-nonce', otcHash: 'code-hash' };
      }
    );
    mockTryReserveSlot.mockResolvedValue({ allowed: true, reservedAt: new Date('2026-01-01T00:00:00.000Z') });
    mockConfirmReservation.mockResolvedValue(true);
  };

  it('logs one code dispatch only after the email event is accepted', async () => {
    dispatchThroughMailer();
    const { req, res } = makeReqRes();
    vi.mocked(EmailEvents.Send.publish).mockImplementationOnce(async () => {
      expect(req.logger.info).not.toHaveBeenCalled();
    });

    await handler(req, res);

    expect(EmailEvents.Send.publish).toHaveBeenCalledTimes(1);
    expect(EmailEvents.Send.publish).toHaveBeenCalledWith(expect.objectContaining({ category: 'otc' }));
    expect(req.logger.info).toHaveBeenCalledExactlyOnceWith('otc-code-dispatched');
  });

  it('does not log a dispatch when email publication rejects', async () => {
    dispatchThroughMailer();
    vi.mocked(EmailEvents.Send.publish).mockRejectedValueOnce(new Error('email unavailable'));
    const { req, res } = makeReqRes();

    await expect(handler(req, res)).rejects.toThrow('email unavailable');

    expect(req.logger.info).not.toHaveBeenCalled();
  });

  it('counts a dispatched email even when token confirmation later loses the race', async () => {
    dispatchThroughMailer();
    mockConfirmReservation.mockResolvedValueOnce(false);
    const { req, res } = makeReqRes();

    await handler(req, res);

    expect(res._getStatusCode()).toBe(429);
    expect(req.logger.info).toHaveBeenCalledExactlyOnceWith('otc-code-dispatched');
  });

  it('does not count an invalid request as a dispatch', async () => {
    const { req, res } = makeReqRes('invalid');
    await handler(req, res);
    expect(res._getStatusCode()).toBe(400);
    expect(req.logger.info).not.toHaveBeenCalled();
  });

  it('does not count a cooldown refusal as a dispatch', async () => {
    mockTryReserveSlot.mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 12 });
    const { req, res } = makeReqRes();
    await handler(req, res);
    expect(res._getStatusCode()).toBe(429);
    expect(req.logger.info).not.toHaveBeenCalled();
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

  it('stores the nonce and code hash server-side and returns only the pending token', async () => {
    const reservedAt = new Date('2026-01-01T00:00:00.000Z');
    mockTryReserveSlot.mockResolvedValue({ allowed: true, reservedAt });
    mockConfirmReservation.mockResolvedValue(true);
    const { req, res } = makeReqRes();

    await handler(req, res);

    expect(mockConfirmReservation).toHaveBeenCalledWith(EMAIL, reservedAt, 'real-nonce', 'code-hash', undefined);
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

    expect(mockConfirmReservation).toHaveBeenCalledWith(EMAIL, reservedAt, 'real-nonce', 'code-hash', '123456');
  });
});

describe('/api/otc/send recipient checks', () => {
  const reservedAt = new Date('2026-01-01T00:00:00.000Z');

  beforeEach(() => {
    vi.clearAllMocks();
    resetCache();
    mockIsE2EEnabled.mockReturnValue(false);
    mockTryReserveSlot.mockResolvedValue({ allowed: true, reservedAt });
    mockConfirmReservation.mockResolvedValue(true);
    mockSendOTC.mockImplementation(
      async (
        params: { email: string },
        adapters: { mailer: { sendOTCEmail: (email: string, code: string) => Promise<void> } }
      ) => {
        await adapters.mailer.sendOTCEmail(params.email, '123456');
        return { pendingToken: 'pending-token', nonce: 'real-nonce', otcHash: 'code-hash', code: '123456' };
      }
    );
  });

  async function send(email = EMAIL) {
    const { req, res } = makeReqRes(email);
    await handler(req, res);
    return { req, res };
  }

  it('answers a refused address with no account exactly as a delivered one, without mailing', async () => {
    const delivered = await send();
    expect(EmailEvents.Send.publish).toHaveBeenCalledTimes(1);
    expect(mockFindByEmail).not.toHaveBeenCalled();

    vi.mocked(EmailEvents.Send.publish).mockClear();
    mockRecipientRefusal.mockResolvedValue('blocked-domain');
    const refused = await send();

    expect(EmailEvents.Send.publish).not.toHaveBeenCalled();
    expect(refused.req.logger.info).toHaveBeenCalledWith('otc-code-suppressed', { reason: 'blocked-domain' });
    expect(refused.res._getStatusCode()).toBe(delivered.res._getStatusCode());
    expect(refused.res._getJSONData()).toEqual(delivered.res._getJSONData());
    expect(mockConfirmReservation).toHaveBeenLastCalledWith(EMAIL, reservedAt, 'real-nonce', 'code-hash', undefined);
  });

  it('still mails an existing account on a refused domain', async () => {
    mockRecipientRefusal.mockResolvedValue('no-mail-host');
    mockFindByEmail.mockResolvedValue({ id: 'user-1' });

    const { res } = await send();

    expect(mockFindByEmail).toHaveBeenCalledWith(EMAIL);
    expect(EmailEvents.Send.publish).toHaveBeenCalledTimes(1);
    expect(res._getStatusCode()).toBe(200);
  });

  it('spends the per-email budgets for a refused address like any other send', async () => {
    mockRecipientRefusal.mockResolvedValue('blocked-domain');
    await send();
    expect(cache.counts.get(`otc-limit:send-email:${otcEmailKey(EMAIL)}`)).toBe(1);
  });
});

describe('/api/otc/send challenge budgets', () => {
  const reservedAt = new Date('2026-01-01T00:00:00.000Z');
  const dailyKey = `otc-limit:send-email-daily-challenge:${otcEmailKey(EMAIL)}`;
  const globalKey = `otc-limit:send-global-hourly-challenge:${otcEmailKey('all')}`;

  beforeEach(() => {
    vi.clearAllMocks();
    resetCache();
    mockIsE2EEnabled.mockReturnValue(false);
    mockTryReserveSlot.mockResolvedValue({ allowed: true, reservedAt });
    mockConfirmReservation.mockResolvedValue(true);
    mockSendOTC.mockResolvedValue({ pendingToken: 'pending-token', nonce: 'real-nonce', otcHash: 'code-hash' });
  });

  async function send(turnstileToken?: string) {
    const { req, res } = makeReqRes();
    req.body.turnstileToken = turnstileToken;
    await handler(req, res);
    return { req, res };
  }

  it('charges both budgets once a code is dispatched, and not on a refused send', async () => {
    await send();
    expect(cache.counts.get(dailyKey)).toBe(1);
    expect(cache.counts.get(globalKey)).toBe(1);

    mockTryReserveSlot.mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 10 });
    await send();
    expect(cache.counts.get(dailyKey)).toBe(1);
  });

  it.each([
    ['inbox daily', () => cache.counts.set(dailyKey, OTC_LIMITS.send.perEmailDailyChallenge.limit)],
    ['deployment hourly', () => cache.counts.set(globalKey, OTC_LIMITS.send.globalHourlyChallenge.limit)],
  ])('asks for a challenge past the %s budget, naming the site key', async (_name, exhaust) => {
    exhaust();
    Object.assign(stepUpPolicy, { active: true, siteKey: 'site', secret: 'secret' });

    const { res } = await send();

    expect(res._getStatusCode()).toBe(403);
    expect(res._getJSONData()).toMatchObject({ code: 'challenge_required', siteKey: 'site' });
    expect(mockTryReserveSlot).not.toHaveBeenCalled();
    expect(mockSendOTC).not.toHaveBeenCalled();
  });

  it('sends past the budget with a valid token, and refuses an invalid one', async () => {
    cache.counts.set(dailyKey, OTC_LIMITS.send.perEmailDailyChallenge.limit);
    Object.assign(stepUpPolicy, { active: true, siteKey: 'site', secret: 'secret' });

    mockCheckTurnstileToken.mockResolvedValueOnce(null);
    expect((await send('good-token')).res._getStatusCode()).toBe(200);
    expect(mockCheckTurnstileToken).toHaveBeenCalledWith(
      expect.anything(),
      'otc-send',
      expect.objectContaining({ siteKey: 'site' }),
      'good-token'
    );

    mockCheckTurnstileToken.mockResolvedValueOnce({
      code: 'challenge_failed',
      status: 403,
      error: 'Verification failed.',
    });
    const refused = await send('bad-token');
    expect(refused.res._getStatusCode()).toBe(403);
    expect(refused.res._getJSONData()).toMatchObject({ code: 'challenge_failed' });
  });

  it('never refuses past the budget when no challenge can be offered', async () => {
    cache.counts.set(dailyKey, OTC_LIMITS.send.perEmailDailyChallenge.limit);
    cache.counts.set(globalKey, OTC_LIMITS.send.globalHourlyChallenge.limit);

    const { req, res } = await send();

    expect(res._getStatusCode()).toBe(200);
    expect(mockSendOTC).toHaveBeenCalledTimes(1);
    expect(req.logger.warn).toHaveBeenCalledWith('otc-send-challenge-budget-exceeded');
  });

  it('skips the challenge budgets under E2E', async () => {
    mockIsE2EEnabled.mockReturnValue(true);
    cache.counts.set(dailyKey, OTC_LIMITS.send.perEmailDailyChallenge.limit);
    Object.assign(stepUpPolicy, { active: true, siteKey: 'site', secret: 'secret' });

    expect((await send()).res._getStatusCode()).toBe(200);
  });
});
