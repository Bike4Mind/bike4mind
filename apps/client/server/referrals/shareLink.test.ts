import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  findById: vi.fn(),
  findOne: vi.fn(),
  updateOne: vi.fn(),
  countDocuments: vi.fn(),
  getSettingsMap: vi.fn(),
  emit: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  User: { findById: m.findById, findOne: m.findOne, updateOne: m.updateOne, countDocuments: m.countDocuments },
}));
vi.mock('@bike4mind/utils', () => ({
  getSettingsMap: m.getSettingsMap,
  getSettingsValue: (key: string, settings: Record<string, unknown>, fallback: number) =>
    key in settings ? Number(settings[key]) : fallback,
}));
vi.mock('@bike4mind/server-utils/analytics/emitActiveEvent', () => ({
  emitProductEvent: m.emit,
  HOST_PRODUCT_ID: 'bike4mind',
}));

import { Logger } from '@bike4mind/observability';
import {
  creditShareLinkSignup,
  getOrCreateReferralCode,
  normalizeReferralCode,
  readReferralCookie,
  referralCookieName,
  referralLinkUrl,
  setReferralCookie,
} from './shareLink';

const NOW = new Date('2026-11-19T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const CODE = 'abcd2345';
const NEW_USER = '64b000000000000000000001';
const REFERRER = '64b000000000000000000002';

/** A Mongoose query chain whose `.lean()` resolves to `doc`. */
const query = (doc: unknown) => {
  const chain = { select: vi.fn(), lean: vi.fn() };
  chain.select.mockReturnValue(chain);
  chain.lean.mockResolvedValue(doc);
  return chain;
};

const reqWithCode = (code: string | null) => ({ headers: code === null ? {} : { cookie: `x=1; b4m_ref=${code}` } });

const referrer = (overrides: Record<string, unknown> = {}) => ({
  _id: REFERRER,
  email: 'pat.lee@gmail.com',
  emailVerified: true,
  authProviders: [],
  signupMeta: { ip: '198.51.100.7' },
  loginRecords: [{ ip: '198.51.100.8' }],
  ...overrides,
});

const newAccount = (overrides: Record<string, unknown> = {}) => ({
  email: 'friend@example.com',
  signupMeta: { ip: '203.0.113.20' },
  referredByUserId: null,
  ...overrides,
});

const credit = (overrides: Partial<Parameters<typeof creditShareLinkSignup>[0]> = {}) =>
  creditShareLinkSignup({
    req: reqWithCode(CODE),
    userId: NEW_USER,
    method: 'otc',
    isSynthetic: false,
    now: NOW,
    ...overrides,
  });

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  m.getSettingsMap.mockResolvedValue({});
  m.findOne.mockReturnValue(query(referrer()));
  m.findById.mockReturnValue(query(newAccount()));
  m.countDocuments.mockResolvedValue(0);
  m.updateOne.mockResolvedValue({ modifiedCount: 1 });
  m.emit.mockResolvedValue(undefined);
});

describe('normalizeReferralCode', () => {
  it('accepts a code in any case and with surrounding space', () => {
    expect(normalizeReferralCode(' ABCD2345 ')).toBe(CODE);
  });

  it.each([
    ['too short', 'abcd234'],
    ['too long', 'abcd23456'],
    ['an ambiguous character', 'abcd2340'],
    ['punctuation', 'abcd-234'],
    ['a non-string', 12345678],
  ])('rejects %s', (_label, raw) => {
    expect(normalizeReferralCode(raw)).toBeNull();
  });
});

describe('referral cookie', () => {
  it('writes a Lax, HttpOnly, 30-day cookie on the whole host', () => {
    const headers = new Map<string, unknown>();
    const res = {
      getHeader: (name: string) => headers.get(name),
      setHeader: (name: string, value: unknown) => headers.set(name, value),
      headersSent: false,
    };
    setReferralCookie(res as never, CODE);
    expect(headers.get('Set-Cookie')).toBe(
      `${referralCookieName()}=${CODE}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax`
    );
  });

  it('reads back only a well-formed code', () => {
    expect(readReferralCookie(reqWithCode(CODE.toUpperCase()))).toBe(CODE);
    expect(readReferralCookie(reqWithCode('nope'))).toBeNull();
    expect(readReferralCookie(reqWithCode(null))).toBeNull();
  });
});

describe('referralLinkUrl', () => {
  it('joins APP_URL and the code without a doubled slash', () => {
    vi.stubEnv('APP_URL', 'https://app.example.test/');
    expect(referralLinkUrl(CODE)).toBe(`https://app.example.test/r/${CODE}`);
    vi.unstubAllEnvs();
  });
});

describe('getOrCreateReferralCode', () => {
  it('returns the stored code without writing', async () => {
    m.findById.mockReturnValue(query({ referralCode: CODE }));
    await expect(getOrCreateReferralCode(REFERRER)).resolves.toBe(CODE);
    expect(m.updateOne).not.toHaveBeenCalled();
  });

  it('mints a code only onto an account that has none, then returns what is stored', async () => {
    m.findById.mockReturnValueOnce(query({ referralCode: null })).mockReturnValueOnce(query({ referralCode: CODE }));
    await expect(getOrCreateReferralCode(REFERRER)).resolves.toBe(CODE);
    const [filter, update, options] = m.updateOne.mock.calls[0];
    expect(filter).toEqual({ _id: REFERRER, referralCode: { $not: { $type: 'string' } } });
    expect(normalizeReferralCode(update.$set.referralCode)).toBe(update.$set.referralCode);
    expect(options).toEqual({ runValidators: true });
  });

  it('draws again when the minted code belongs to another account', async () => {
    m.findById
      .mockReturnValueOnce(query({ referralCode: null }))
      .mockReturnValueOnce(query({ referralCode: null }))
      .mockReturnValueOnce(query({ referralCode: CODE }));
    m.updateOne.mockRejectedValueOnce({ code: 11000 }).mockResolvedValueOnce({ modifiedCount: 1 });
    await expect(getOrCreateReferralCode(REFERRER)).resolves.toBe(CODE);
    expect(m.updateOne).toHaveBeenCalledTimes(2);
  });

  it('gives up after repeated collisions rather than looping', async () => {
    m.findById.mockReturnValue(query({ referralCode: null }));
    m.updateOne.mockRejectedValue({ code: 11000 });
    await expect(getOrCreateReferralCode(REFERRER)).rejects.toThrow('Could not mint a unique referral code');
    expect(m.updateOne).toHaveBeenCalledTimes(5);
  });

  it('surfaces any other write error', async () => {
    m.findById.mockReturnValue(query({ referralCode: null }));
    m.updateOne.mockRejectedValue(new Error('connection reset'));
    await expect(getOrCreateReferralCode(REFERRER)).rejects.toThrow('connection reset');
  });
});

describe('creditShareLinkSignup', () => {
  it('does nothing for a browser without a referral cookie', async () => {
    await expect(credit({ req: reqWithCode(null) })).resolves.toBeNull();
    expect(m.getSettingsMap).not.toHaveBeenCalled();
    expect(m.emit).not.toHaveBeenCalled();
  });

  it('credits the link owner and stamps when, leaving an invite referral untouched', async () => {
    await expect(credit()).resolves.toBe('credited');
    expect(m.findOne).toHaveBeenCalledWith({ referralCode: CODE });
    expect(m.updateOne).toHaveBeenCalledWith(
      { _id: NEW_USER, referredByUserId: null },
      { $set: { referredByUserId: REFERRER, referredViaLinkAt: NOW } },
      { runValidators: true }
    );
    expect(m.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'referral_link_signup',
        userId: NEW_USER,
        metadata: { outcome: 'credited', method: 'otc' },
      })
    );
  });

  it('credits nobody while the monthly limit is 0', async () => {
    m.getSettingsMap.mockResolvedValue({ ReferralLinkSignupsPerMonth: 0 });
    await expect(credit()).resolves.toBe('disabled');
    expect(m.findOne).not.toHaveBeenCalled();
    expect(m.updateOne).not.toHaveBeenCalled();
  });

  it('credits nobody for a code no account holds', async () => {
    m.findOne.mockReturnValue(query(null));
    await expect(credit()).resolves.toBe('unknown_code');
    expect(m.updateOne).not.toHaveBeenCalled();
  });

  it('leaves an account an invite already credited', async () => {
    m.findById.mockReturnValue(query(newAccount({ referredByUserId: '64b000000000000000000009' })));
    await expect(credit()).resolves.toBe('already_referred');
    expect(m.updateOne).not.toHaveBeenCalled();
  });

  it('reports the invite as the winner when it lands between the read and the write', async () => {
    m.updateOne.mockResolvedValue({ modifiedCount: 0 });
    await expect(credit()).resolves.toBe('already_referred');
  });

  it.each([
    ['an unverified email and no provider', { emailVerified: false, authProviders: [] }],
    ['a banned account', { isBanned: true }],
    ['a deleted account', { deletedAt: new Date('2026-11-01') }],
  ])('refuses a referrer with %s', async (_label, overrides) => {
    m.findOne.mockReturnValue(query(referrer(overrides)));
    await expect(credit()).resolves.toBe('referrer_ineligible');
    expect(m.updateOne).not.toHaveBeenCalled();
  });

  it('accepts a referrer whose email a sign-in provider vouched for', async () => {
    m.findOne.mockReturnValue(query(referrer({ emailVerified: false, authProviders: [{ strategy: 'google' }] })));
    await expect(credit()).resolves.toBe('credited');
  });

  it('refuses a signup on an alias of the referrer inbox', async () => {
    m.findById.mockReturnValue(query(newAccount({ email: 'Pat.Lee+alt@gmail.com' })));
    await expect(credit()).resolves.toBe('own_account');
    expect(m.updateOne).not.toHaveBeenCalled();
  });

  it.each([
    ['the referrer signed up from', '198.51.100.7'],
    ['the referrer logged in from', '198.51.100.8'],
  ])('refuses a signup from the IP %s', async (_label, ip) => {
    m.findById.mockReturnValue(query(newAccount({ signupMeta: { ip } })));
    await expect(credit()).resolves.toBe('shared_network');
    expect(m.updateOne).not.toHaveBeenCalled();
  });

  it('stops crediting once the 30-day limit is reached', async () => {
    m.getSettingsMap.mockResolvedValue({ ReferralLinkSignupsPerMonth: 3 });
    m.countDocuments.mockResolvedValue(3);
    await expect(credit()).resolves.toBe('monthly_cap');
    expect(m.countDocuments).toHaveBeenCalledWith({
      referredByUserId: REFERRER,
      referredViaLinkAt: { $gte: new Date(NOW.getTime() - 30 * DAY_MS) },
    });
    expect(m.updateOne).not.toHaveBeenCalled();
  });

  it('still credits one under the limit', async () => {
    m.getSettingsMap.mockResolvedValue({ ReferralLinkSignupsPerMonth: 3 });
    m.countDocuments.mockResolvedValue(2);
    await expect(credit()).resolves.toBe('credited');
  });

  it('credits a test persona without reporting it', async () => {
    await expect(credit({ isSynthetic: true })).resolves.toBe('credited');
    expect(m.emit).not.toHaveBeenCalled();
  });

  it('never fails the signup when a read throws', async () => {
    m.findOne.mockImplementation(() => {
      throw new Error('db down');
    });
    const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
    await expect(credit()).resolves.toBeNull();
    expect(warn).toHaveBeenCalledWith('[referral] share link signup was not credited', {
      userId: NEW_USER,
      errorName: 'Error',
    });
    expect(m.emit).not.toHaveBeenCalled();
  });
});
