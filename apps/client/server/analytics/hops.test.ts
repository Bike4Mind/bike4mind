// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OverwatchAnalyticsEventSchema, OVERWATCH_UNKNOWN_SESSION_ID } from '@bike4mind/common';
import type { IAnalyticsHopDoc } from '@bike4mind/database';

const { config, mockCreate, mockRedeem, mockEmitProductEvent } = vi.hoisted(() => ({
  config: { OVERWATCH_PSEUDONYM_SALT: 'test-salt' } as Record<string, string | undefined>,
  mockCreate: vi.fn(),
  mockRedeem: vi.fn(),
  mockEmitProductEvent: vi.fn(),
}));

vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: config }));
vi.mock('@bike4mind/database', () => ({
  analyticsHopRepository: { create: mockCreate, redeem: mockRedeem },
}));
vi.mock('@bike4mind/server-utils/analytics/emitActiveEvent', () => ({
  HOST_PRODUCT_ID: 'bike4mind',
  emitProductEvent: (...args: unknown[]) => mockEmitProductEvent(...args),
}));

import {
  HOP_COOKIE_TTL_SECONDS,
  HOP_RECORD_RETENTION_DAYS,
  HopMintBodySchema,
  hopCookieHeader,
  hopLandingUrl,
  hopMintedEvent,
  mintHop,
  readHopCookie,
  readHopToken,
  redeemHop,
} from './hops';
import { HOP_TOKEN_TTL_SECONDS, deriveHopKey, signHopToken, verifyHopToken } from './hopToken';

const KEY = deriveHopKey('test-salt');
const NOW = new Date('2026-11-03T12:00:00.000Z');
const NOW_S = NOW.getTime() / 1000;
const HOP_ID = 'c'.repeat(32);
const VISIT_ID = 'f'.repeat(32);

const storedHop = (over: Partial<IAnalyticsHopDoc> = {}): IAnalyticsHopDoc => ({
  _id: 'id',
  hopId: HOP_ID,
  srcProductId: 'source-product',
  dest: 'bike4mind',
  createdAt: new Date(NOW.getTime() - 60_000),
  redeemedAt: NOW,
  ...over,
});

const liveToken = (over: { hopId?: string; exp?: number; dest?: string } = {}) =>
  signHopToken(KEY, { hopId: over.hopId ?? HOP_ID, exp: over.exp ?? NOW_S + 300, dest: over.dest ?? 'bike4mind' });

beforeEach(() => {
  vi.clearAllMocks();
  config.OVERWATCH_PSEUDONYM_SALT = 'test-salt';
  mockCreate.mockImplementation(async (input: Omit<IAnalyticsHopDoc, '_id' | 'redeemedAt'>) => ({
    _id: 'id',
    redeemedAt: null,
    ...input,
  }));
  mockEmitProductEvent.mockResolvedValue(undefined);
});

afterEach(() => {
  delete process.env.APP_URL;
});

describe('HopMintBodySchema', () => {
  it('accepts a destination alone, and every optional field', () => {
    expect(HopMintBodySchema.safeParse({ dest: 'bike4mind' }).success).toBe(true);
    const full = {
      dest: 'bike4mind',
      path: '/skills/market',
      srcSessionId: 'sess-123:abc',
      srcVisitorHash: 'b'.repeat(64),
      lane: 'synthetic',
    };
    expect(HopMintBodySchema.parse(full)).toEqual(full);
  });

  it('refuses a body that names a source: the source is the key', () => {
    for (const key of ['src', 'srcProductId', 'productId']) {
      expect(HopMintBodySchema.safeParse({ dest: 'bike4mind', [key]: 'another-product' }).success, key).toBe(false);
    }
  });

  it('refuses a destination that cannot redeem', () => {
    for (const dest of ['another-product', '', undefined, 'BIKE4MIND']) {
      expect(HopMintBodySchema.safeParse({ dest }).success, String(dest)).toBe(false);
    }
  });

  it('refuses a path that is not a path on the destination', () => {
    for (const path of [
      '',
      'new',
      '//evil.example',
      'https://evil.example/',
      '/new?x=1',
      '/new#a',
      '/a\\b',
      `/${'a'.repeat(200)}`,
    ]) {
      expect(HopMintBodySchema.safeParse({ dest: 'bike4mind', path }).success, path).toBe(false);
    }
  });

  it('refuses a visitor identifier that is not a hash', () => {
    for (const srcVisitorHash of ['someone@example.com', 'short', 'has spaces in it ok?', 'x'.repeat(129)]) {
      expect(HopMintBodySchema.safeParse({ dest: 'bike4mind', srcVisitorHash }).success, srcVisitorHash).toBe(false);
    }
  });

  it('accepts only the synthetic lane', () => {
    expect(HopMintBodySchema.safeParse({ dest: 'bike4mind', lane: 'real' }).success).toBe(false);
  });
});

describe('mintHop', () => {
  it('stores the hop under the given source and returns a token for it', async () => {
    const minted = await mintHop(
      { dest: 'bike4mind', path: '/new', srcSessionId: 's1', lane: 'synthetic', srcProductId: 'source-product' },
      NOW
    );

    expect(mockCreate).toHaveBeenCalledOnce();
    const stored = mockCreate.mock.calls[0][0];
    expect(stored).toMatchObject({
      srcProductId: 'source-product',
      dest: 'bike4mind',
      path: '/new',
      srcSessionId: 's1',
      lane: 'synthetic',
      createdAt: NOW,
    });
    expect(stored).not.toHaveProperty('srcVisitorHash');
    expect(stored.expiresAt).toEqual(new Date(NOW.getTime() + HOP_RECORD_RETENTION_DAYS * 86_400_000));

    expect(minted?.expiresAt).toEqual(new Date(NOW.getTime() + HOP_TOKEN_TTL_SECONDS * 1000));
    const check = verifyHopToken(KEY, minted?.token, { dest: 'bike4mind', nowSeconds: NOW_S });
    expect(check).toEqual({ ok: true, hopId: stored.hopId, exp: NOW_S + HOP_TOKEN_TTL_SECONDS });
  });

  it('mints nothing, and stores nothing, without a hop key', async () => {
    config.OVERWATCH_PSEUDONYM_SALT = 'not-configured';
    expect(await mintHop({ dest: 'bike4mind', srcProductId: 'source-product' }, NOW)).toBeNull();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('returns the landing URL when the app URL is known', async () => {
    process.env.APP_URL = 'https://app.example.com';
    const minted = await mintHop({ dest: 'bike4mind', path: '/new', srcProductId: 'source-product' }, NOW);
    const url = new URL(minted!.url!);
    expect(url.origin + url.pathname).toBe('https://app.example.com/new');
    expect(url.searchParams.get('b4m_hop')).toBe(minted!.token);
  });
});

describe('hopLandingUrl', () => {
  it('lands on the root without a path, and is absent without an app URL', () => {
    expect(hopLandingUrl(undefined, 't', 'https://app.example.com')).toBe('https://app.example.com/?b4m_hop=t');
    expect(hopLandingUrl('/new', 't', undefined)).toBeUndefined();
    expect(hopLandingUrl('/new', 't', 'not a url')).toBeUndefined();
  });
});

describe('hopMintedEvent', () => {
  it('is a valid ingest event under the source product, naming the hop and its destination', () => {
    const event = hopMintedEvent(storedHop({ srcSessionId: 'src-session', lane: 'synthetic' }));
    expect(OverwatchAnalyticsEventSchema.safeParse(event).success).toBe(true);
    expect(event).toMatchObject({
      productId: 'source-product',
      event: 'hop_minted',
      sessionId: 'src-session',
      userId: 'overwatch:anonymous',
      metadata: { hopId: HOP_ID, dest: 'bike4mind', lane: 'synthetic' },
    });
  });

  it('names no session when the source sent none, and keeps a stable event id', () => {
    const event = hopMintedEvent(storedHop());
    expect(event.sessionId).toBe(OVERWATCH_UNKNOWN_SESSION_ID);
    expect(event.metadata).toEqual({ hopId: HOP_ID, dest: 'bike4mind' });
    expect(hopMintedEvent(storedHop()).eventId).toBe(event.eventId);
  });
});

describe('redeemHop', () => {
  it('redeems a live token once, linking the visit with consent, and sends hop', async () => {
    mockRedeem.mockResolvedValue(storedHop({ redeemedSessionId: VISIT_ID, lane: 'synthetic' }));

    const outcome = await redeemHop({ token: liveToken(), visitId: VISIT_ID, linkVisit: true, now: NOW });

    expect(outcome.redeemed).toBe(true);
    expect(mockRedeem).toHaveBeenCalledWith({
      hopId: HOP_ID,
      dest: 'bike4mind',
      now: NOW,
      mintedSince: new Date(NOW.getTime() - HOP_TOKEN_TTL_SECONDS * 1000),
      sessionId: VISIT_ID,
    });
    expect(mockEmitProductEvent).toHaveBeenCalledOnce();
    expect(mockEmitProductEvent.mock.calls[0][0]).toMatchObject({
      productId: 'bike4mind',
      event: 'hop',
      sessionId: VISIT_ID,
      metadata: { hopId: HOP_ID, src: 'source-product', dest: 'bike4mind', verified: true, lane: 'synthetic' },
    });
  });

  it('without consent, redeems and counts the hop but links no visit', async () => {
    mockRedeem.mockResolvedValue(storedHop());

    const outcome = await redeemHop({ token: liveToken(), visitId: VISIT_ID, linkVisit: false, now: NOW });

    expect(outcome.redeemed).toBe(true);
    expect(mockRedeem.mock.calls[0][0]).not.toHaveProperty('sessionId');
    const sent = mockEmitProductEvent.mock.calls[0][0];
    expect(sent).not.toHaveProperty('sessionId');
    expect(sent.metadata).toEqual({ hopId: HOP_ID, src: 'source-product', dest: 'bike4mind', verified: true });
  });

  it.each([
    ['an expired token', () => liveToken({ exp: NOW_S - 1 }), 'expired'],
    ['a token for another destination', () => liveToken({ dest: 'another-product' }), 'bad_signature'],
    ['a forged token', () => `${HOP_ID}.${NOW_S + 300}.${'A'.repeat(43)}`, 'bad_signature'],
    ['a malformed token', () => 'not-a-token', 'malformed'],
  ])('refuses %s without asking the store or sending anything', async (_name, make, reason) => {
    const outcome = await redeemHop({ token: make(), visitId: VISIT_ID, linkVisit: true, now: NOW });
    expect(outcome).toEqual({ redeemed: false, reason });
    expect(mockRedeem).not.toHaveBeenCalled();
    expect(mockEmitProductEvent).not.toHaveBeenCalled();
  });

  it('sends nothing when the store refuses (redeemed already, or not this destination)', async () => {
    mockRedeem.mockResolvedValue(null);
    expect(await redeemHop({ token: liveToken(), visitId: VISIT_ID, linkVisit: true, now: NOW })).toEqual({
      redeemed: false,
      reason: 'refused',
    });
    expect(mockEmitProductEvent).not.toHaveBeenCalled();
  });

  it('never throws on a store failure', async () => {
    mockRedeem.mockRejectedValue(new Error('connection reset'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await redeemHop({ token: liveToken(), visitId: VISIT_ID, linkVisit: true, now: NOW })).toEqual({
      redeemed: false,
      reason: 'error',
    });
    expect(mockEmitProductEvent).not.toHaveBeenCalled();
    // The token is never what gets logged.
    expect(JSON.stringify(warn.mock.calls)).not.toContain(liveToken());
    warn.mockRestore();
  });

  it('redeems nothing without a hop key', async () => {
    config.OVERWATCH_PSEUDONYM_SALT = undefined;
    expect(await redeemHop({ token: liveToken(), visitId: VISIT_ID, linkVisit: true, now: NOW })).toEqual({
      redeemed: false,
      reason: 'not_configured',
    });
    expect(mockRedeem).not.toHaveBeenCalled();
  });
});

describe('readHopToken', () => {
  it('reads a token string from a beacon body, and nothing else', () => {
    expect(readHopToken({ hop: 'abc', landingPath: '/' })).toBe('abc');
    for (const body of [undefined, null, 'abc', {}, { hop: '' }, { hop: 42 }, { hop: 'x'.repeat(129) }]) {
      expect(readHopToken(body), JSON.stringify(body)).toBeUndefined();
    }
  });
});

describe('the b4m_hop cookie', () => {
  it('holds the hop id for 24 hours, HttpOnly and Lax', () => {
    const header = hopCookieHeader(HOP_ID, { secure: true });
    expect(header).toBe(`b4m_hop=${HOP_ID}; Path=/; Max-Age=${HOP_COOKIE_TTL_SECONDS}; HttpOnly; SameSite=Lax; Secure`);
    expect(HOP_COOKIE_TTL_SECONDS).toBe(86_400);
    expect(hopCookieHeader(HOP_ID, { secure: false })).not.toContain('Secure');
  });

  it('is read back only when it holds a hop id', () => {
    expect(readHopCookie(`b4m_vid=${VISIT_ID}; b4m_hop=${HOP_ID}`)).toBe(HOP_ID);
    for (const cookie of [undefined, '', 'b4m_hop=', 'b4m_hop=everyone', `b4m_hop=${HOP_ID}x`]) {
      expect(readHopCookie(cookie), String(cookie)).toBeUndefined();
    }
  });
});
