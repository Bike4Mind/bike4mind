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
  findByKey: vi.fn(),
  createOrUpdate: vi.fn(),
  existsVerifiedUserOnEmailDomain: vi.fn<(domain: string, verifiedBefore: Date) => Promise<boolean>>(),
  settings: {} as Record<string, string>,
}));

vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  cacheRepository: {
    tryIncrementWithinLimitFixedWindow: mocks.tryIncrement,
    tryAddWithinLimitFixedWindow: mocks.tryAdd,
    deleteByKey: mocks.deleteByKey,
    decrementCounter: mocks.decrementCounter,
    findByKey: mocks.findByKey,
    createOrUpdate: mocks.createOrUpdate,
  },
  userRepository: { existsVerifiedUserOnEmailDomain: mocks.existsVerifiedUserOnEmailDomain },
}));
vi.mock('@bike4mind/utils', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/utils')>()),
  getSettingsMap: async () => mocks.settings,
}));
vi.mock('@bike4mind/server-utils/utils/ip', () => ({ getClientIp: () => '203.0.113.7' }));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ isE2EEnabled: () => mocks.isE2EEnabled() }));

import { settingsMap } from '@bike4mind/common';
import {
  OTC_ESTABLISHED_DOMAIN_MIN_AGE_MS,
  OTC_LIMITS,
  OTC_SEND_CHALLENGE_BUDGETS,
  OTC_SEND_EMAIL_BUDGETS,
  OTC_VERIFY_EMAIL_BUDGETS,
  chargeOtcEmailBudget,
  ipSubject,
  otcCounterLimit,
  otcDistinctEmailsPerIpLimit,
  otcEmailBudgetRetryAfter,
  otcEmailKey,
  otcIpBucket,
  otcLimitDomain,
  otcLimitOf,
  reserveOtcRegistrationDomainBudget,
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
      await otcCounterLimit({ bucket, window: cfg, subject: ipSubject })(makeReq('a@b.co'), res, next);
      expect(mocks.tryIncrement).toHaveBeenLastCalledWith(`otc-limit:${bucket}:203.0.113.7`, cfg.limit, cfg.windowMs);
      expect(next.mock.calls[0][0]).toBeInstanceOf(TooManyRequestsError);
      expect(res.setHeader).toHaveBeenCalledWith('Retry-After', 90);
    }
  });

  it('skips the check when the subject is missing, and in E2E', async () => {
    const mw = otcCounterLimit({
      bucket: 'send-ip-total',
      window: OTC_LIMITS.send.perIpTotal,
      subject: () => undefined,
    });
    const next = vi.fn();
    await mw(makeReq('a@b.co'), makeRes(), next);
    mocks.isE2EEnabled.mockReturnValue(true);
    await otcCounterLimit({ bucket: 'send-ip-total', window: OTC_LIMITS.send.perIpTotal, subject: ipSubject })(
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
    expect(inboxWide.map(b => b.window.windowMs)).toEqual([OTC_LIMITS.send.perEmail.windowMs]);
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

describe('admin-lowered limits', () => {
  const windows = [
    ...Object.values(OTC_LIMITS.send),
    ...Object.values(OTC_LIMITS.verify),
    ...Object.values(OTC_LIMITS.register),
  ].filter(w => typeof w === 'object');

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.settings = {};
    mocks.isE2EEnabled.mockReturnValue(false);
    mocks.tryIncrement.mockResolvedValue(allowed);
  });

  it("declares one setting per window, capped at the window's built-in limit", () => {
    expect(new Set(windows.map(w => w.setting)).size).toBe(windows.length);
    for (const window of windows) {
      const setting = settingsMap[window.setting];
      expect(setting.type).toBe('number');
      expect(setting.defaultValue).toBe(0);
      expect('max' in setting && setting.max).toBe(window.limit);
    }
  });

  it('lowers a limit, and keeps the built-in for 0 or an out-of-range stored value', async () => {
    const { perIpTotal } = OTC_LIMITS.send;
    expect(await otcLimitOf(perIpTotal)).toBe(perIpTotal.limit);
    mocks.settings = { [perIpTotal.setting]: '3' };
    expect(await otcLimitOf(perIpTotal)).toBe(3);
    mocks.settings = { [perIpTotal.setting]: String(perIpTotal.limit + 100) };
    expect(await otcLimitOf(perIpTotal)).toBe(perIpTotal.limit);
    mocks.settings = { [perIpTotal.setting]: '0' };
    expect(await otcLimitOf(perIpTotal)).toBe(perIpTotal.limit);
  });

  it('counts against the lowered limit', async () => {
    const { perIpTotal } = OTC_LIMITS.send;
    mocks.settings = { [perIpTotal.setting]: '2' };
    await otcCounterLimit({ bucket: 'send-ip-total', window: perIpTotal, subject: ipSubject })(
      makeReq('a@b.co'),
      makeRes(),
      vi.fn()
    );
    expect(mocks.tryIncrement).toHaveBeenCalledWith('otc-limit:send-ip-total:203.0.113.7', 2, perIpTotal.windowMs);
  });

  const ip = '203.0.113.7';
  const counter = (bucket: string, window: (typeof windows)[number]) => () =>
    otcCounterLimit({ bucket, window, subject: ipSubject })(makeReq('a@b.co'), makeRes(), vi.fn());
  const reserveSend = () => reserveOtcEmailBudget('a@b.co', ip, OTC_SEND_EMAIL_BUDGETS);
  const loweredCases = [
    ['send.perEmailPerIp', OTC_LIMITS.send.perEmailPerIp, 'otc-limit:send-email-ip:', reserveSend],
    ['send.perEmailPerIpDaily', OTC_LIMITS.send.perEmailPerIpDaily, 'otc-limit:send-email-ip-daily:', reserveSend],
    ['send.perEmail', OTC_LIMITS.send.perEmail, 'otc-limit:send-email:', reserveSend],
    [
      'send.perEmailDailyChallenge',
      OTC_LIMITS.send.perEmailDailyChallenge,
      'otc-limit:send-email-daily-challenge:',
      () => chargeOtcEmailBudget('a@b.co', ip, OTC_SEND_CHALLENGE_BUDGETS),
    ],
    [
      'send.globalHourlyChallenge',
      OTC_LIMITS.send.globalHourlyChallenge,
      'otc-limit:send-global-hourly-challenge:',
      () => chargeOtcEmailBudget('a@b.co', ip, OTC_SEND_CHALLENGE_BUDGETS),
    ],
    [
      'send.perIpDistinctEmails',
      OTC_LIMITS.send.perIpDistinctEmails,
      'otc-limit:ip-distinct:',
      () => otcDistinctEmailsPerIpLimit()(makeReq('a@b.co'), makeRes(), vi.fn()),
    ],
    [
      'send.perIpTotal',
      OTC_LIMITS.send.perIpTotal,
      'otc-limit:send-ip-total:',
      counter('send-ip-total', OTC_LIMITS.send.perIpTotal),
    ],
    [
      'send.perIpDaily',
      OTC_LIMITS.send.perIpDaily,
      'otc-limit:send-ip-daily:',
      counter('send-ip-daily', OTC_LIMITS.send.perIpDaily),
    ],
    [
      'verify.perEmailPerIp',
      OTC_LIMITS.verify.perEmailPerIp,
      'otc-limit:verify-email-ip:',
      () => reserveOtcEmailBudget('a@b.co', ip, OTC_VERIFY_EMAIL_BUDGETS),
    ],
    ['verify.perIp', OTC_LIMITS.verify.perIp, 'otc-limit:verify-ip:', counter('verify-ip', OTC_LIMITS.verify.perIp)],
    [
      'register.perDomainHourly',
      OTC_LIMITS.register.perDomainHourly,
      'otc-limit:register-domain-hourly:',
      () => reserveOtcRegistrationDomainBudget('x@new.example'),
    ],
    [
      'register.perDomainDaily',
      OTC_LIMITS.register.perDomainDaily,
      'otc-limit:register-domain-daily:',
      () => reserveOtcRegistrationDomainBudget('x@new.example'),
    ],
  ] as const;

  it('covers every window with a lowered-limit case', () => {
    expect(new Set(loweredCases.map(([, window]) => window.setting))).toEqual(new Set(windows.map(w => w.setting)));
  });

  it.each(loweredCases)('counts %s against its lowered limit', async (_name, window, keyPrefix, exercise) => {
    mocks.tryAdd.mockResolvedValue({ success: true, count: 0, expiresAt: new Date(Date.now() + 60_000) });
    mocks.settings = { [window.setting]: '1' };
    await exercise();

    const call = mocks.tryIncrement.mock.calls.find(([key]) => key.startsWith(keyPrefix));
    expect(call?.[1]).toBe(1);
    expect(window.limit).toBeGreaterThan(1);
  });

  it.each([
    ['send.perEmailPerIp', OTC_SEND_EMAIL_BUDGETS, OTC_LIMITS.send.perEmailPerIp, 'otc-limit:send-email-ip:'],
    [
      'send.perEmailPerIpDaily',
      OTC_SEND_EMAIL_BUDGETS,
      OTC_LIMITS.send.perEmailPerIpDaily,
      'otc-limit:send-email-ip-daily:',
    ],
    ['send.perEmail', OTC_SEND_EMAIL_BUDGETS, OTC_LIMITS.send.perEmail, 'otc-limit:send-email:'],
    ['verify.perEmailPerIp', OTC_VERIFY_EMAIL_BUDGETS, OTC_LIMITS.verify.perEmailPerIp, 'otc-limit:verify-email-ip:'],
  ] as const)('checks %s against its lowered limit without spending', async (_name, budgets, window, keyPrefix) => {
    mocks.tryAdd.mockResolvedValue({ success: true, count: 0, expiresAt: new Date(Date.now() + 60_000) });
    mocks.settings = { [window.setting]: '1' };
    await otcEmailBudgetRetryAfter('a@b.co', ip, budgets);

    const call = mocks.tryAdd.mock.calls.find(([key]) => key.startsWith(keyPrefix));
    expect(call?.[2]).toBe(1);
  });
});

describe('otcLimitDomain', () => {
  it('keys every subdomain and alias of a domain on its registrable domain', () => {
    expect(otcLimitDomain('a@burner.io')).toBe('burner.io');
    expect(otcLimitDomain('b+x@zz.burner.io')).toBe('burner.io');
    expect(otcLimitDomain('c@q.Burner.IO.')).toBe('burner.io');
    expect(otcLimitDomain('d@mail.acme.co.uk')).toBe('acme.co.uk');
  });

  it('exempts personal mail providers and unparseable domains', () => {
    expect(otcLimitDomain('someone@gmail.com')).toBeUndefined();
    expect(otcLimitDomain('someone@googlemail.com')).toBeUndefined();
    expect(otcLimitDomain('someone@outlook.com')).toBeUndefined();
    expect(otcLimitDomain('someone@co.uk')).toBeUndefined();
  });
});

describe('reserveOtcRegistrationDomainBudget', () => {
  const spent = { success: false, count: 5, expiresAt: new Date(Date.now() + 60_000) };
  const hourlyKey = `otc-limit:register-domain-hourly:${otcEmailKey('new.example')}`;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.settings = {};
    mocks.isE2EEnabled.mockReturnValue(false);
    mocks.tryIncrement.mockResolvedValue(allowed);
    mocks.findByKey.mockResolvedValue(null);
    mocks.existsVerifiedUserOnEmailDomain.mockResolvedValue(false);
  });

  it('charges nothing for a personal provider', async () => {
    expect(await reserveOtcRegistrationDomainBudget('someone@gmail.com')).toHaveProperty('refund');
    expect(mocks.tryIncrement).not.toHaveBeenCalled();
  });

  it('charges both domain windows without a user lookup while they have room', async () => {
    expect(await reserveOtcRegistrationDomainBudget('x@a.new.example')).toHaveProperty('refund');
    const { perDomainHourly, perDomainDaily } = OTC_LIMITS.register;
    expect(mocks.tryIncrement).toHaveBeenCalledWith(hourlyKey, perDomainHourly.limit, perDomainHourly.windowMs);
    expect(mocks.tryIncrement).toHaveBeenCalledWith(
      `otc-limit:register-domain-daily:${otcEmailKey('new.example')}`,
      perDomainDaily.limit,
      perDomainDaily.windowMs
    );
    expect(mocks.existsVerifiedUserOnEmailDomain).not.toHaveBeenCalled();
  });

  it('refuses a spent budget for a domain with no week-old verified account, and caches that', async () => {
    mocks.tryIncrement.mockResolvedValue(spent);
    const before = Date.now();
    expect(await reserveOtcRegistrationDomainBudget('x@new.example')).toHaveProperty('retryAfter');
    const after = Date.now();

    const [domain, verifiedBefore] = mocks.existsVerifiedUserOnEmailDomain.mock.calls[0];
    expect(domain).toBe('new.example');
    expect(verifiedBefore.getTime()).toBeGreaterThanOrEqual(before - OTC_ESTABLISHED_DOMAIN_MIN_AGE_MS);
    expect(verifiedBefore.getTime()).toBeLessThanOrEqual(after - OTC_ESTABLISHED_DOMAIN_MIN_AGE_MS);
    expect(mocks.createOrUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ key: `otc-domain-established:${otcEmailKey('new.example')}`, result: false })
    );
  });

  it('pins the registration windows to 5 per hour and 20 per day', async () => {
    await reserveOtcRegistrationDomainBudget('x@new.example');

    expect(mocks.tryIncrement).toHaveBeenCalledTimes(2);
    expect(mocks.tryIncrement).toHaveBeenCalledWith(hourlyKey, 5, 3_600_000);
    expect(mocks.tryIncrement).toHaveBeenCalledWith(
      `otc-limit:register-domain-daily:${otcEmailKey('new.example')}`,
      20,
      86_400_000
    );
  });

  it('treats a domain as established only for accounts verified at least 7 days ago', async () => {
    vi.useFakeTimers({ now: new Date('2026-03-10T12:00:00.000Z') });
    try {
      mocks.tryIncrement.mockResolvedValue(spent);
      await reserveOtcRegistrationDomainBudget('x@new.example');

      const [, verifiedBefore] = mocks.existsVerifiedUserOnEmailDomain.mock.calls[0];
      expect(verifiedBefore.getTime()).toBe(Date.now() - 7 * 86_400_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['established', true, 86_400_000],
    ['not established', false, 3_600_000],
  ])('caches the %s verdict for the matching time', async (_name, established, ttlMs) => {
    vi.useFakeTimers({ now: new Date('2026-03-10T12:00:00.000Z') });
    try {
      mocks.tryIncrement.mockResolvedValue(spent);
      mocks.existsVerifiedUserOnEmailDomain.mockResolvedValue(established);
      await reserveOtcRegistrationDomainBudget('x@new.example');

      const [entry] = mocks.createOrUpdate.mock.calls[0];
      expect(entry.result).toBe(established);
      expect(entry.expiresAt.getTime()).toBe(Date.now() + ttlMs);
    } finally {
      vi.useRealTimers();
    }
  });

  it('admits an established domain past a spent budget', async () => {
    mocks.tryIncrement.mockResolvedValue(spent);
    mocks.existsVerifiedUserOnEmailDomain.mockResolvedValue(true);
    expect(await reserveOtcRegistrationDomainBudget('x@acme.example')).toHaveProperty('refund');
  });

  it('answers from the cache without scanning users', async () => {
    mocks.tryIncrement.mockResolvedValue(spent);
    mocks.findByKey.mockResolvedValue({ result: true });
    expect(await reserveOtcRegistrationDomainBudget('x@acme.example')).toHaveProperty('refund');
    expect(mocks.existsVerifiedUserOnEmailDomain).not.toHaveBeenCalled();
    expect(mocks.createOrUpdate).not.toHaveBeenCalled();
  });
});
