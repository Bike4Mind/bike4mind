// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { createMocks } from 'node-mocks-http';

const { mockFindById, mockPreview, mockRedeem, mockRungCredits } = vi.hoisted(() => ({
  mockFindById: vi.fn(),
  mockPreview: vi.fn(),
  mockRedeem: vi.fn(),
  mockRungCredits: vi.fn(),
}));

vi.mock('@server/utils/analyticsLog', () => ({ logEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@server/middlewares/csrfProtection', () => ({
  csrfProtection: () => (_q: unknown, _r: unknown, n: () => void) => n(),
}));
vi.mock('@server/middlewares/rateLimit', () => ({ rateLimit: () => (_q: unknown, _r: unknown, n: () => void) => n() }));
vi.mock('@bike4mind/server-utils/auth/mfaEnforcement', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  isMfaEnrollmentOwed: async () => false,
}));
vi.mock('@server/partners/bedrocknewsTickets', () => ({
  previewTicket: (...a: unknown[]) => mockPreview(...a),
  redeemTicket: (...a: unknown[]) => mockRedeem(...a),
}));
vi.mock('@server/partners/bedrocknewsPuzzleReward', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  rungCredits: (...a: unknown[]) => mockRungCredits(...a),
}));
vi.mock('@bike4mind/database', async orig => {
  const actual = await orig<Record<string, unknown>>();
  const RealUser = actual.User as Record<string, unknown>;
  return {
    ...actual,
    connectDB: vi.fn().mockResolvedValue(undefined),
    User: Object.assign(Object.create(RealUser), { findById: (...a: unknown[]) => mockFindById(...a) }),
  };
});

import previewHandler from '../bedrocknews/claims/[ticket]';
import redeemHandler from '../bedrocknews/claims/[ticket]/redeem';
import { Logger } from '@bike4mind/observability';

const TICKET = 'abcdefghijklmnopqrstuv';
const SESSION_USER = {
  id: 'a1b2c3d4e5f6a1b2c3d4e5f6',
  _id: 'a1b2c3d4e5f6a1b2c3d4e5f6',
  aupAcceptedVersion: 'grandfathered',
};
const EMAIL = 'victor@bike4mind.com';
const PAYABLE = { emailVerified: true, email: EMAIL };
const RUNGS = [
  { date: '2026-11-02', length: 5, hard: false },
  { date: '2026-11-01', length: 7, hard: true },
];
const RESULT = { claimed: [], total: 130, balance: 1630, firstSolveCredits: 0, capped: 0 };

const dbUser = (user: unknown) => mockFindById.mockReturnValue({ select: () => ({ lean: async () => user }) });

function fire(method: 'GET' | 'POST', { signedIn = true }: { signedIn?: boolean } = {}) {
  const { req, res } = createMocks(
    { method, url: `/api/partners/bedrocknews/claims/${TICKET}`, query: { ticket: TICKET }, headers: {} },
    { eventEmitter: EventEmitter }
  );
  if (signedIn) (req as { user?: unknown }).user = SESSION_USER;
  return { req: req as any, res: res as any };
}

const get = async (opts?: { signedIn?: boolean }) => {
  const { req, res } = fire('GET', opts);
  await previewHandler(req, res);
  return res;
};
const post = async (opts?: { signedIn?: boolean }) => {
  const { req, res } = fire('POST', opts);
  await redeemHandler(req, res);
  return res;
};
const fail = (code: string, status: number) => ({ ok: false, code, status });

describe('BedrockNews claim routes', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    warn = vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
    dbUser(PAYABLE);
    mockRungCredits.mockResolvedValue(130);
  });
  afterEach(() => warn.mockRestore());

  it.each([
    ['GET', get],
    ['POST', post],
  ])('%s answers 401 without a session', async (_m, run) => {
    const res = await run({ signedIn: false });
    expect(res._getStatusCode()).toBe(401);
    expect(mockPreview).not.toHaveBeenCalled();
    expect(mockRedeem).not.toHaveBeenCalled();
  });

  describe('GET preview', () => {
    it('is ready with the priced rungs and the session user own email', async () => {
      mockPreview.mockResolvedValue({ ok: true, preview: { status: 'open', expiresAt: 'x', rungs: RUNGS } });
      const res = await get();
      expect(res._getStatusCode()).toBe(200);
      expect(res._getJSONData()).toEqual({ state: 'ready', credits: 130, rungs: RUNGS, account: EMAIL });
      expect(mockPreview).toHaveBeenCalledWith(TICKET);
      expect(mockRungCredits).toHaveBeenCalledWith([
        { tier: 5, hard: false },
        { tier: 7, hard: true },
      ]);
    });

    it('reads a stale redeeming status as ready', async () => {
      mockPreview.mockResolvedValue({ ok: true, preview: { status: 'redeeming', expiresAt: 'x', rungs: RUNGS } });
      expect((await get())._getJSONData()).toMatchObject({ state: 'ready' });
    });

    it('is redeemed with the stored result', async () => {
      mockPreview.mockResolvedValue({
        ok: true,
        preview: { status: 'redeemed', expiresAt: 'x', rungs: RUNGS, result: RESULT },
      });
      expect((await get())._getJSONData()).toEqual({ state: 'redeemed', result: RESULT });
    });

    it('is expired for an expired status', async () => {
      mockPreview.mockResolvedValue({ ok: true, preview: { status: 'expired', expiresAt: 'x', rungs: RUNGS } });
      expect((await get())._getJSONData()).toEqual({ state: 'expired' });
    });

    it('is unavailable for a redeemed ticket with no result', async () => {
      mockPreview.mockResolvedValue({ ok: true, preview: { status: 'redeemed', expiresAt: 'x', rungs: RUNGS } });
      expect((await get())._getJSONData()).toEqual({ state: 'unavailable' });
    });

    it.each([
      ['not-found', fail('TICKET_NOT_FOUND', 404)],
      ['expired', fail('TICKET_EXPIRED', 410)],
      ['unavailable', fail('BEDROCKNEWS_UNAVAILABLE', 502)],
      ['unavailable', fail('PARTNER_KEY_INVALID', 401)],
      ['unavailable', fail('NOT_CONFIGURED', 503)],
      ['unavailable', fail('INVALID_REQUEST', 400)],
    ])('answers %s for %j', async (state, failure) => {
      mockPreview.mockResolvedValue(failure);
      const res = await get();
      expect(res._getStatusCode()).toBe(200);
      expect(res._getJSONData()).toEqual({ state });
    });

    it('warns server-side naming the code when the partner key or config is bad', async () => {
      mockPreview.mockResolvedValue(fail('PARTNER_KEY_INVALID', 401));
      await get();
      expect(JSON.stringify(warn.mock.calls)).toContain('PARTNER_KEY_INVALID');
    });

    it.each([
      ['unverified email', { ...PAYABLE, emailVerified: false }],
      ['banned', { ...PAYABLE, isBanned: true }],
      ['missing user', null],
    ])('is verify-email for %s without calling BedrockNews', async (_l, user) => {
      dbUser(user);
      const res = await get();
      expect(res._getJSONData()).toEqual({ state: 'verify-email' });
      expect(mockPreview).not.toHaveBeenCalled();
    });
  });

  describe('POST redeem', () => {
    it('passes the session user id and the DB email, answering done', async () => {
      mockRedeem.mockResolvedValue({ ok: true, result: RESULT });
      const res = await post();
      expect(res._getJSONData()).toEqual({ state: 'done', result: RESULT });
      expect(mockRedeem).toHaveBeenCalledWith(TICKET, { id: SESSION_USER.id, email: EMAIL });
    });

    it('is verify-email for an ineligible user and does not redeem', async () => {
      dbUser({ ...PAYABLE, emailVerified: false });
      const res = await post();
      expect(res._getJSONData()).toEqual({ state: 'verify-email' });
      expect(mockRedeem).not.toHaveBeenCalled();
    });

    it.each([
      ['expired', fail('TICKET_EXPIRED', 410)],
      ['in-progress', fail('CLAIM_IN_PROGRESS', 409)],
      ['budget-spent', fail('B4M_BUDGET_SPENT', 503)],
      ['verify-email', fail('B4M_NOT_ELIGIBLE', 403)],
      ['not-found', fail('TICKET_NOT_FOUND', 404)],
      ['unavailable', fail('BEDROCKNEWS_UNAVAILABLE', 502)],
      ['unavailable', fail('B4M_UNAVAILABLE', 502)],
      ['unavailable', fail('INVALID_REQUEST', 400)],
      ['unavailable', fail('PARTNER_KEY_INVALID', 401)],
      ['unavailable', fail('NOT_CONFIGURED', 503)],
    ])('answers %s for %j', async (state, failure) => {
      mockRedeem.mockResolvedValue(failure);
      const res = await post();
      expect(res._getStatusCode()).toBe(200);
      expect(res._getJSONData()).toEqual({ state });
    });

    it('warns server-side naming the code when the partner key or config is bad', async () => {
      mockRedeem.mockResolvedValue(fail('NOT_CONFIGURED', 503));
      await post();
      expect(JSON.stringify(warn.mock.calls)).toContain('NOT_CONFIGURED');
    });
  });
});
