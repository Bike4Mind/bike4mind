import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TooManyRequestsError } from '@bike4mind/utils';
import type { Request, Response } from 'express';

const mocks = vi.hoisted(() => ({
  tryIncrement:
    vi.fn<
      (key: string, limit: number, ttlMs: number) => Promise<{ success: boolean; count: number; expiresAt: Date }>
    >(),
  deleteByKey: vi.fn(),
  isE2EEnabled: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  cacheRepository: { tryIncrementWithinLimitFixedWindow: mocks.tryIncrement, deleteByKey: mocks.deleteByKey },
}));
vi.mock('@server/utils/ip', () => ({ getClientIp: () => '203.0.113.7' }));
vi.mock('@server/utils/config', () => ({ isE2EEnabled: () => mocks.isE2EEnabled() }));

import {
  OTC_LIMITS,
  emailSubject,
  ipSubject,
  otcCounterLimit,
  otcDistinctEmailsPerIpLimit,
  otcEmailKey,
  otcLimitMailbox,
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

  it('counts sends per normalized email, ignoring case and whitespace, under a hashed key', async () => {
    const mw = otcCounterLimit({ bucket: 'send-email', ...OTC_LIMITS.send.perEmail, subject: emailSubject });
    const next = vi.fn();
    await mw(makeReq('  Someone@Example.com '), makeRes(), next);

    const key = `otc-limit:send-email:${otcEmailKey('someone@example.com')}`;
    expect(mocks.tryIncrement).toHaveBeenCalledWith(
      key,
      OTC_LIMITS.send.perEmail.limit,
      OTC_LIMITS.send.perEmail.windowMs
    );
    expect(key).not.toContain('example.com');
    expect(next).toHaveBeenCalledWith();
  });

  it('counts plus-tag, Gmail-dot and compatibility-form variants of one inbox on the same key', async () => {
    const mw = otcCounterLimit({ bucket: 'send-email', ...OTC_LIMITS.send.perEmail, subject: emailSubject });
    for (const variant of [
      'victim@gmail.com',
      'V.i.c.t.i.m@gmail.com',
      'victim+bomb1@gmail.com',
      'vic.tim+x@googlemail.com',
      'victim@gmail.com.',
      '\uff56ictim@gmail.com',
    ]) {
      await mw(makeReq(variant), makeRes(), vi.fn());
    }

    const keys = new Set(mocks.tryIncrement.mock.calls.map(([key]) => key));
    expect(keys).toEqual(new Set([`otc-limit:send-email:${otcEmailKey('victim@gmail.com')}`]));
  });

  it('folds plus-tags on any domain but keeps dots significant outside Gmail', () => {
    expect(otcLimitMailbox('first.last+tag@example.com')).toBe('first.last@example.com');
    expect(otcLimitMailbox('first.last@example.com')).not.toBe(otcLimitMailbox('firstlast@example.com'));
  });

  it('rejects a per-email send over the limit with 429 and Retry-After', async () => {
    mocks.tryIncrement.mockResolvedValue(denied());
    const mw = otcCounterLimit({ bucket: 'send-email', ...OTC_LIMITS.send.perEmail, subject: emailSubject });
    const res = makeRes();
    const next = vi.fn();
    await mw(makeReq('a@b.co'), res, next);

    expect(next.mock.calls[0][0]).toBeInstanceOf(TooManyRequestsError);
    expect(res.setHeader).toHaveBeenCalledWith('Retry-After', 90);
  });

  it('bounds the daily per-email count on its own key', async () => {
    const mw = otcCounterLimit({ bucket: 'send-email-daily', ...OTC_LIMITS.send.perEmailDaily, subject: emailSubject });
    await mw(makeReq('a@b.co'), makeRes(), vi.fn());

    expect(mocks.tryIncrement).toHaveBeenCalledWith(
      expect.stringContaining('otc-limit:send-email-daily:'),
      OTC_LIMITS.send.perEmailDaily.limit,
      OTC_LIMITS.send.perEmailDaily.windowMs
    );
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

  it('limits verification attempts per email across tokens', async () => {
    mocks.tryIncrement.mockResolvedValue(denied());
    const res = makeRes();
    const next = vi.fn();
    await otcCounterLimit({ bucket: 'verify-email', ...OTC_LIMITS.verify.perEmail, subject: emailSubject })(
      makeReq('a@b.co'),
      res,
      next
    );

    expect(next.mock.calls[0][0]).toBeInstanceOf(TooManyRequestsError);
    expect(res.setHeader).toHaveBeenCalledWith('Retry-After', 90);
  });

  it('skips the check when the body has no usable email, and in E2E', async () => {
    const mw = otcCounterLimit({ bucket: 'send-email', ...OTC_LIMITS.send.perEmail, subject: emailSubject });
    const next = vi.fn();
    await mw(makeReq(undefined), makeRes(), next);
    mocks.isE2EEnabled.mockReturnValue(true);
    await mw(makeReq('a@b.co'), makeRes(), next);

    expect(mocks.tryIncrement).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(2);
  });
});

describe('otcDistinctEmailsPerIpLimit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isE2EEnabled.mockReturnValue(false);
  });

  it('does not spend a slot on a repeat of an (IP, email) pair', async () => {
    mocks.tryIncrement.mockResolvedValueOnce(denied());
    const next = vi.fn();
    await otcDistinctEmailsPerIpLimit()(makeReq('a@b.co'), makeRes(), next);

    expect(mocks.tryIncrement).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith();
  });

  it('takes a slot for a new email and allows it while under the limit', async () => {
    mocks.tryIncrement.mockResolvedValue(allowed);
    const next = vi.fn();
    await otcDistinctEmailsPerIpLimit()(makeReq('a@b.co'), makeRes(), next);

    expect(mocks.tryIncrement).toHaveBeenLastCalledWith(
      'otc-limit:ip-distinct:203.0.113.7',
      OTC_LIMITS.send.perIpDistinctEmails.limit,
      OTC_LIMITS.send.perIpDistinctEmails.windowMs
    );
    expect(next).toHaveBeenCalledWith();
  });

  it('refuses a new email past the distinct limit with Retry-After and releases the pair marker', async () => {
    mocks.tryIncrement.mockResolvedValueOnce(allowed).mockResolvedValueOnce(denied());
    const res = makeRes();
    const next = vi.fn();
    await otcDistinctEmailsPerIpLimit()(makeReq('a@b.co'), res, next);

    expect(next.mock.calls[0][0]).toBeInstanceOf(TooManyRequestsError);
    expect(res.setHeader).toHaveBeenCalledWith('Retry-After', 90);
    expect(mocks.deleteByKey).toHaveBeenCalledWith(`otc-limit:ip-email-seen:203.0.113.7:${otcEmailKey('a@b.co')}`);
  });
});
