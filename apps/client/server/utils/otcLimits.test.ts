import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TooManyRequestsError } from '@bike4mind/utils';
import type { Request, Response } from 'express';

type CounterResult = { success: boolean; count: number; expiresAt: Date };

const mocks = vi.hoisted(() => ({
  tryIncrement: vi.fn<(key: string, limit: number, ttlMs: number) => Promise<CounterResult>>(),
  tryAdd: vi.fn<(key: string, amount: number, limit: number, ttlMs: number) => Promise<CounterResult>>(),
  deleteByKey: vi.fn(),
  decrementCounter: vi.fn(),
  isE2EEnabled: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  cacheRepository: {
    tryIncrementWithinLimitFixedWindow: mocks.tryIncrement,
    tryAddWithinLimitFixedWindow: mocks.tryAdd,
    deleteByKey: mocks.deleteByKey,
    decrementCounter: mocks.decrementCounter,
  },
}));
vi.mock('@server/utils/ip', () => ({ getClientIp: () => '203.0.113.7' }));
vi.mock('@server/utils/config', () => ({ isE2EEnabled: () => mocks.isE2EEnabled() }));

import {
  OTC_LIMITS,
  OTC_SEND_EMAIL_BUDGETS,
  OTC_VERIFY_EMAIL_BUDGETS,
  chargeOtcEmailBudget,
  ipSubject,
  otcCounterLimit,
  otcDistinctEmailsPerIpLimit,
  otcEmailBudgetRetryAfter,
  otcEmailKey,
  otcIpBucket,
  otcLimitMailbox,
  reserveOtcEmailBudget,
} from './otcLimits';

const makeReq = (email?: unknown) => ({ body: { email } }) as unknown as Request;
const makeRes = () => ({ setHeader: vi.fn() }) as unknown as Response & { setHeader: ReturnType<typeof vi.fn> };
const allowed = { success: true, count: 1, expiresAt: new Date(Date.now() + 60_000) };
const denied = () => ({ success: false, count: 5, expiresAt: new Date(Date.now() + 90_000) });

describe('otcCounterLimit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isE2EEnabled.mockReturnValue(false);
    mocks.tryIncrement.mockResolvedValue(allowed);
  });

  it('bounds total and daily sends per IP', async () => {
    mocks.tryIncrement.mockResolvedValue(denied());
    for (const [bucket, cfg] of [
      ['send-ip-total', OTC_LIMITS.send.perIpTotal],
      ['send-ip-daily', OTC_LIMITS.send.perIpDaily],
    ] as const) {
      const res = makeRes();
      const next = vi.fn();
      await otcCounterLimit({ bucket, ...cfg, subject: ipSubject })(makeReq('a@b.co'), res, next);
      expect(mocks.tryIncrement).toHaveBeenLastCalledWith(`otc-limit:${bucket}:203.0.113.7`, cfg.limit, cfg.windowMs);
      expect(next.mock.calls[0][0]).toBeInstanceOf(TooManyRequestsError);
      expect(res.setHeader).toHaveBeenCalledWith('Retry-After', 90);
    }
  });

  it('skips the check when the subject is missing, and in E2E', async () => {
    const mw = otcCounterLimit({ bucket: 'send-ip-total', ...OTC_LIMITS.send.perIpTotal, subject: () => undefined });
    const next = vi.fn();
    await mw(makeReq('a@b.co'), makeRes(), next);
    mocks.isE2EEnabled.mockReturnValue(true);
    await otcCounterLimit({ bucket: 'send-ip-total', ...OTC_LIMITS.send.perIpTotal, subject: ipSubject })(
      makeReq('a@b.co'),
      makeRes(),
      next
    );

    expect(mocks.tryIncrement).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(2);
  });
});

describe('per-email budgets', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isE2EEnabled.mockReturnValue(false);
    mocks.tryIncrement.mockResolvedValue(allowed);
    mocks.tryAdd.mockResolvedValue({ success: true, count: 0, expiresAt: new Date(Date.now() + 60_000) });
  });

  it('charges each send budget once, per source and inbox-wide, under hashed keys', async () => {
    await chargeOtcEmailBudget('someone@example.com', '203.0.113.7', OTC_SEND_EMAIL_BUDGETS);

    const perSource = otcEmailKey('someone@example.com|203.0.113.7');
    const { perEmail, perEmailPerIp, perEmailPerIpDaily } = OTC_LIMITS.send;
    expect(mocks.tryIncrement).toHaveBeenCalledTimes(3);
    expect(mocks.tryIncrement).toHaveBeenCalledWith(
      `otc-limit:send-email-ip:${perSource}`,
      perEmailPerIp.limit,
      perEmailPerIp.windowMs
    );
    expect(mocks.tryIncrement).toHaveBeenCalledWith(
      `otc-limit:send-email-ip-daily:${perSource}`,
      perEmailPerIpDaily.limit,
      perEmailPerIpDaily.windowMs
    );
    expect(mocks.tryIncrement).toHaveBeenCalledWith(
      `otc-limit:send-email:${otcEmailKey('someone@example.com')}`,
      perEmail.limit,
      perEmail.windowMs
    );
    expect(mocks.tryIncrement.mock.calls.every(([key]) => !key.includes('example.com'))).toBe(true);
  });

  it('never refuses an inbox for longer than one short window across all sources', () => {
    const inboxWide = OTC_SEND_EMAIL_BUDGETS.filter(
      b => b.subject('a@b.co', '1.1.1.1') === b.subject('a@b.co', '2.2.2.2')
    );
    expect(inboxWide.map(b => b.windowMs)).toEqual([OTC_LIMITS.send.perEmail.windowMs]);
    expect(OTC_LIMITS.send.perEmail.windowMs).toBeLessThanOrEqual(15 * 60_000);
  });

  it('counts plus-tag, Gmail-dot and compatibility-form variants of one inbox on the same key', async () => {
    for (const variant of [
      'victim@gmail.com',
      'v.i.c.t.i.m@gmail.com',
      'victim+bomb1@gmail.com',
      'vic.tim+x@googlemail.com',
      'victim@gmail.com.',
      '\uff56ictim@gmail.com',
    ]) {
      await chargeOtcEmailBudget(variant, '203.0.113.7', OTC_SEND_EMAIL_BUDGETS);
    }

    const keys = new Set(mocks.tryIncrement.mock.calls.map(([key]) => key));
    expect(keys).toEqual(
      new Set([
        `otc-limit:send-email-ip:${otcEmailKey('victim@gmail.com|203.0.113.7')}`,
        `otc-limit:send-email-ip-daily:${otcEmailKey('victim@gmail.com|203.0.113.7')}`,
        `otc-limit:send-email:${otcEmailKey('victim@gmail.com')}`,
      ])
    );
  });

  it('keys the verify budget on the exact address and the verifying source, not the folded inbox', async () => {
    await chargeOtcEmailBudget('victim+x@gmail.com', '203.0.113.7', OTC_VERIFY_EMAIL_BUDGETS);

    expect(mocks.tryIncrement).toHaveBeenCalledWith(
      `otc-limit:verify-email-ip:${otcEmailKey('victim+x@gmail.com|203.0.113.7')}`,
      OTC_LIMITS.verify.perEmailPerIp.limit,
      OTC_LIMITS.verify.perEmailPerIp.windowMs
    );
  });

  it('folds plus-tags on any domain but keeps dots significant outside Gmail', () => {
    expect(otcLimitMailbox('first.last+tag@example.com')).toBe('first.last@example.com');
    expect(otcLimitMailbox('first.last@example.com')).not.toBe(otcLimitMailbox('firstlast@example.com'));
  });

  it('reports Retry-After without spending anything once a budget is spent', async () => {
    mocks.tryAdd.mockImplementation(async (key, _amount, limit) =>
      key.startsWith('otc-limit:send-email-ip-daily:')
        ? { success: true, count: limit, expiresAt: new Date(Date.now() + 90_000) }
        : { success: true, count: 0, expiresAt: new Date(Date.now() + 60_000) }
    );

    await expect(otcEmailBudgetRetryAfter('a@b.co', '203.0.113.7', OTC_SEND_EMAIL_BUDGETS)).resolves.toBe(90);
    expect(mocks.tryAdd.mock.calls.every(([, amount]) => amount === 0)).toBe(true);
    expect(mocks.tryIncrement).not.toHaveBeenCalled();
  });

  it('reports no wait while every budget has room', async () => {
    await expect(otcEmailBudgetRetryAfter('a@b.co', '203.0.113.7', OTC_VERIFY_EMAIL_BUDGETS)).resolves.toBeUndefined();
  });

  it('reserves every send budget or none, handing back units taken before a full one', async () => {
    mocks.tryIncrement.mockImplementation(async key => (key.startsWith('otc-limit:send-email:') ? denied() : allowed));

    const result = await reserveOtcEmailBudget('a@b.co', '203.0.113.7', OTC_SEND_EMAIL_BUDGETS);

    expect(result).toEqual({ retryAfter: 90 });
    expect(mocks.decrementCounter.mock.calls.map(([key]) => key)).toEqual([
      `otc-limit:send-email-ip:${otcEmailKey('a@b.co|203.0.113.7')}`,
      `otc-limit:send-email-ip-daily:${otcEmailKey('a@b.co|203.0.113.7')}`,
    ]);
  });

  it('refunds a successful reservation on request', async () => {
    const result = await reserveOtcEmailBudget('a@b.co', '203.0.113.7', OTC_SEND_EMAIL_BUDGETS);
    if (!('refund' in result)) throw new Error('expected a reservation');
    expect(mocks.decrementCounter).not.toHaveBeenCalled();

    await result.refund();
    expect(mocks.decrementCounter).toHaveBeenCalledTimes(OTC_SEND_EMAIL_BUDGETS.length);
  });

  it("skips the refund for a window that rolled over, so it never returns another caller's unit", async () => {
    vi.useFakeTimers({ now: new Date('2026-01-01T00:00:00.000Z') });
    try {
      const dailyKey = `otc-limit:send-email-ip-daily:${otcEmailKey('a@b.co|203.0.113.7')}`;
      mocks.tryIncrement.mockImplementation(async key => ({
        success: true,
        count: 1,
        expiresAt: new Date(Date.now() + (key === dailyKey ? 60 * 60_000 : 1_000)),
      }));
      const result = await reserveOtcEmailBudget('a@b.co', '203.0.113.7', OTC_SEND_EMAIL_BUDGETS);
      if (!('refund' in result)) throw new Error('expected a reservation');

      vi.advanceTimersByTime(2_000);
      await result.refund();

      expect(mocks.decrementCounter.mock.calls.map(([key]) => key)).toEqual([dailyKey]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('neither checks nor charges in E2E', async () => {
    mocks.isE2EEnabled.mockReturnValue(true);
    await expect(otcEmailBudgetRetryAfter('a@b.co', '203.0.113.7', OTC_SEND_EMAIL_BUDGETS)).resolves.toBeUndefined();
    await chargeOtcEmailBudget('a@b.co', '203.0.113.7', OTC_SEND_EMAIL_BUDGETS);
    await expect(reserveOtcEmailBudget('a@b.co', '203.0.113.7', OTC_SEND_EMAIL_BUDGETS)).resolves.toHaveProperty(
      'refund'
    );

    expect(mocks.tryAdd).not.toHaveBeenCalled();
    expect(mocks.tryIncrement).not.toHaveBeenCalled();
  });
});

describe('otcIpBucket', () => {
  it('keys IPv4 on the full address', () => {
    expect(otcIpBucket('203.0.113.7')).toBe('203.0.113.7');
  });

  it('buckets every address in one IPv6 /64 together, however it is written', () => {
    const bucket = otcIpBucket('2001:db8:aa:1::1');
    expect(bucket).toBe('2001:db8:aa:1::/64');
    for (const sibling of [
      '2001:0db8:00aa:0001:ffff:ffff:ffff:fffe',
      '2001:DB8:AA:1:1:2:3:4',
      '2001:db8:aa:1::9%eth0',
    ]) {
      expect(otcIpBucket(sibling)).toBe(bucket);
    }
    expect(otcIpBucket('2001:db8:aa:2::1')).not.toBe(bucket);
    expect(otcIpBucket('2001:db8::1')).toBe('2001:db8:0:0::/64');
  });

  it('keys IPv4-mapped IPv6 as IPv4 and leaves unparseable input unchanged', () => {
    expect(otcIpBucket('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(otcIpBucket('unknown')).toBe('unknown');
    expect(otcIpBucket('1::2::3')).toBe('1::2::3');
    expect(otcIpBucket('1:2:3')).toBe('1:2:3');
  });
});

describe('otcDistinctEmailsPerIpLimit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isE2EEnabled.mockReturnValue(false);
  });

  const pairKey = `otc-limit:ip-email-seen:203.0.113.7:${otcEmailKey('a@b.co')}`;
  const seenCount = (count: number) => ({ success: true, count, expiresAt: new Date(Date.now() + 60_000) });

  it('does not spend a slot on a repeat of an (IP, email) pair', async () => {
    mocks.tryAdd.mockResolvedValue(seenCount(1));
    const next = vi.fn();
    await otcDistinctEmailsPerIpLimit()(makeReq('a@b.co'), makeRes(), next);

    expect(mocks.tryAdd).toHaveBeenCalledWith(pairKey, 0, 1, OTC_LIMITS.send.perIpDistinctEmails.windowMs);
    expect(mocks.tryIncrement).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith();
  });

  it('takes a slot for a new email, then marks the pair seen', async () => {
    mocks.tryAdd.mockResolvedValue(seenCount(0));
    mocks.tryIncrement.mockResolvedValue(allowed);
    const next = vi.fn();
    await otcDistinctEmailsPerIpLimit()(makeReq('a@b.co'), makeRes(), next);

    expect(mocks.tryIncrement.mock.calls.map(([key]) => key)).toEqual(['otc-limit:ip-distinct:203.0.113.7', pairKey]);
    expect(mocks.tryIncrement).toHaveBeenNthCalledWith(
      1,
      'otc-limit:ip-distinct:203.0.113.7',
      OTC_LIMITS.send.perIpDistinctEmails.limit,
      OTC_LIMITS.send.perIpDistinctEmails.windowMs
    );
    expect(next).toHaveBeenCalledWith();
  });

  it('refuses a new email past the distinct limit with Retry-After and leaves no pair marker', async () => {
    mocks.tryAdd.mockResolvedValue(seenCount(0));
    mocks.tryIncrement.mockResolvedValueOnce(denied());
    const res = makeRes();
    const next = vi.fn();
    await otcDistinctEmailsPerIpLimit()(makeReq('a@b.co'), res, next);

    expect(next.mock.calls[0][0]).toBeInstanceOf(TooManyRequestsError);
    expect(res.setHeader).toHaveBeenCalledWith('Retry-After', 90);
    expect(mocks.tryIncrement).toHaveBeenCalledTimes(1);
    expect(mocks.tryIncrement).not.toHaveBeenCalledWith(pairKey, expect.anything(), expect.anything());
  });
});
