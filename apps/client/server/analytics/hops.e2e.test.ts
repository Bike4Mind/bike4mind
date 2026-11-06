// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { createMocks } from 'node-mocks-http';
import type { MongoMemoryServer } from 'mongodb-memory-server';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';

// Boots a real mongod: the redeem's single use is a property of the store's conditional update,
// which only a real server can show.
vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const { config, queued, productEvents, visitEvents } = vi.hoisted(() => ({
  config: { OVERWATCH_INGEST_ENABLED: 'true', OVERWATCH_PSEUDONYM_SALT: 'e2e-salt', STAGE: 'test' } as Record<
    string,
    string | undefined
  >,
  queued: [] as Record<string, unknown>[],
  productEvents: [] as Record<string, unknown>[],
  visitEvents: [] as Record<string, unknown>[],
}));

// Both routes' baseApi chains reduced to their handlers: auth is the events route's, covered there.
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const api = { use: () => api, post: (fn: unknown) => fn };
    return api;
  },
}));
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({ rateLimit: () => () => undefined }));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: config, isDevelopment: () => false }));
vi.mock('@bike4mind/server-utils/utils/dlqRegistry', () => ({ getSourceQueueUrl: () => 'queue-url' }));
vi.mock('@bike4mind/server-utils/utils/sqs', () => ({
  sendBatchToQueue: async (_url: string, events: Record<string, unknown>[]) => {
    queued.push(...events);
    return events.map((_e, index) => ({ index, success: true }));
  },
}));
vi.mock('@bike4mind/server-utils/utils/cloudwatch', () => ({ emitMetric: async () => undefined }));
vi.mock('@bike4mind/server-utils/referrals/firstAnswerReward', () => ({
  rewardInviterForFirstAnswer: async () => undefined,
}));
vi.mock('@bike4mind/server-utils/analytics/emitActiveEvent', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/server-utils/analytics/emitActiveEvent')>()),
  isAnalyticsConfigured: () => true,
  emitProductEvent: async (event: Record<string, unknown>) => {
    productEvents.push(event);
  },
  emitVisitEvent: async (event: Record<string, unknown>) => {
    visitEvents.push(event);
  },
}));

import mintRoute from '../../pages/api/overwatch/v1/hops';
import visitBeacon from '../../pages/api/analytics/visit';
import { AnalyticsHop, analyticsHopRepository, User } from '@bike4mind/database';
import { ApiKeyScope, type IUserAcquisition } from '@bike4mind/common';
import { mintHop } from './hops';
import { emitSignupFunnelEvents, recordSignupAcquisition } from './funnel';
import { deriveHopKey, signHopToken } from './hopToken';
import { readVisitId, VISIT_COOKIE } from './visitSession';

const SOURCE = 'persona-source';
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124 Safari/537.36';

type MockRes = { _getStatusCode(): number; _getJSONData(): Record<string, unknown>; getHeader(n: string): unknown };

/** The source's `/out/b4m` endpoint: its server mints with its own ingest key. */
async function sourceMints(body: Record<string, unknown> = { dest: 'bike4mind' }) {
  const { req, res } = createMocks({ method: 'POST', body });
  Object.assign(req, {
    apiKeyInfo: { scopes: [ApiKeyScope.OVERWATCH_INGEST_WRITE], productId: SOURCE, keyId: 'persona-key' },
  });
  await (mintRoute as unknown as (q: unknown, s: unknown) => Promise<void>)(req, res);
  const r = res as unknown as MockRes;
  expect(r._getStatusCode()).toBe(201);
  return r._getJSONData() as { hopId: string; token: string };
}

/** The landing page's visit beacon, carrying the token the page took off its URL. */
async function browserLands(token: string, opts: { cookie?: string } = {}) {
  const { req, res } = createMocks({ method: 'POST', body: { landingPath: '/new', hop: token } });
  req.headers = { 'user-agent': BROWSER_UA, ...(opts.cookie && { cookie: opts.cookie }) } as never;
  await (visitBeacon as unknown as (q: unknown, s: unknown) => Promise<void>)(req, res);
  const setCookie = ((res as unknown as MockRes).getHeader('Set-Cookie') as string[] | undefined) ?? [];
  const visitId = readVisitId(setCookie.find(c => c.startsWith(`${VISIT_COOKIE}=`))?.split(';')[0]);
  const hopCookie = setCookie.find(c => c.startsWith('b4m_hop='))?.split(';')[0];
  return { visitId: visitId!, hopCookie };
}

const hopEvents = () => productEvents.filter(e => e.event === 'hop');

/**
 * A new account created in a browser carrying these cookies, through the shared signup write that
 * every self-service signup path runs (OAuth callbacks, OTC verify): the stored acquisition and
 * the account's signup_completed event.
 */
async function signsUp(cookie: string, username = `persona-hop-${Math.random().toString(36).slice(2, 10)}`) {
  const account = await User.create({ name: 'Persona', username, password: null, hasUsablePassword: false });
  productEvents.length = 0;
  const visitId = readVisitId(cookie);
  const funnel = await recordSignupAcquisition({ req: { headers: { cookie } }, user: account, method: 'otc' });
  await emitSignupFunnelEvents({
    user: { id: account.id, ...funnel },
    method: 'otc',
    emailVerified: true,
    creditsGranted: 0,
    ...(visitId && { visitId }),
  });
  const stored = await User.findById(account.id).lean<{ acquisition?: IUserAcquisition }>();
  const signupCompleted = productEvents.find(e => e.event === 'signup_completed');
  return { acquisition: stored?.acquisition, signupCompleted };
}

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await createMongoServer();
  await mongoose.connect(mongod.getUri());
  await AnalyticsHop.createIndexes();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  queued.length = 0;
  productEvents.length = 0;
  visitEvents.length = 0;
  await AnalyticsHop.deleteMany({});
  await User.deleteMany({});
});

describe('the persona walk', () => {
  it('mint -> redeem once -> replay, expired and wrong-destination refused -> signup carries verifiedTouch', async () => {
    // 1. The source's /out endpoint mints, for a persona run.
    const { hopId, token } = await sourceMints({ dest: 'bike4mind', path: '/new', lane: 'synthetic' });

    // 2. The browser lands with the token, consent granted: redeemed, linked to the visit.
    const landing = await browserLands(token, { cookie: 'b4m_consent=granted' });
    expect(landing.hopCookie).toBe(`b4m_hop=${hopId}`);
    expect(hopEvents()).toHaveLength(1);

    // 3. The same token again is refused.
    const replay = await browserLands(token, { cookie: 'b4m_consent=granted' });
    expect(replay.hopCookie).toBeUndefined();

    // 4. A token past its 10 minutes is refused.
    const stale = await mintHop({ dest: 'bike4mind', srcProductId: SOURCE }, new Date(Date.now() - 11 * 60_000));
    expect((await browserLands(stale!.token, { cookie: 'b4m_consent=granted' })).hopCookie).toBeUndefined();

    // 5. A token minted for another destination is refused.
    const exp = Math.floor(Date.now() / 1000) + 300;
    const otherHop = 'e'.repeat(32);
    await analyticsHopRepository.create({
      hopId: otherHop,
      srcProductId: SOURCE,
      dest: 'bike4mind',
      createdAt: new Date(),
    });
    const misdirected = signHopToken(deriveHopKey('e2e-salt'), { hopId: otherHop, exp, dest: 'another-product' });
    expect((await browserLands(misdirected, { cookie: 'b4m_consent=granted' })).hopCookie).toBeUndefined();
    expect(hopEvents()).toHaveLength(1);

    // 6. The persona signs up in the same visit: the account carries the verified touch, and
    // signup_completed carries the hop for Overwatch to count, in the synthetic lane.
    const cookie = `${VISIT_COOKIE}=${landing.visitId}; ${landing.hopCookie}; b4m_consent=granted`;
    const signup = await signsUp(cookie);
    expect(signup.acquisition?.verifiedTouch).toEqual({ srcProductId: SOURCE, hopId, redeemedAt: expect.any(Date) });
    expect(signup.signupCompleted).toMatchObject({
      event: 'signup_completed',
      sessionId: landing.visitId,
      metadata: { method: 'otc', hopId, srcProductId: SOURCE, lane: 'synthetic' },
    });
    // The bound hop is evidence a payment may cite: no longer swept.
    const bound = await analyticsHopRepository.findByHopId(hopId);
    expect(bound?.boundAt).toBeInstanceOf(Date);
    expect(bound).not.toHaveProperty('expiresAt');

    // 7. A signup that followed no hop carries none.
    const plain = await signsUp(`${VISIT_COOKIE}=${'b'.repeat(32)}; b4m_consent=granted`);
    expect(plain.acquisition?.verifiedTouch).toBeUndefined();
    expect(plain.signupCompleted?.metadata).not.toHaveProperty('hopId');
    expect(plain.signupCompleted?.metadata).not.toHaveProperty('srcProductId');
  });
});

describe('binding a signup to a hop', () => {
  async function redeemedHop() {
    const { hopId, token } = await sourceMints();
    const landing = await browserLands(token, { cookie: 'b4m_consent=granted' });
    return { hopId, landing, cookie: `${VISIT_COOKIE}=${landing.visitId}; ${landing.hopCookie}` };
  }

  it('binds one account per hop: a second signup in the same browser gets none', async () => {
    const { hopId, cookie } = await redeemedHop();

    const first = await signsUp(`${cookie}; b4m_consent=granted`, 'first-account');
    const second = await signsUp(`${cookie}; b4m_consent=granted`, 'second-account');

    expect(first.acquisition?.verifiedTouch?.hopId).toBe(hopId);
    expect(second.acquisition?.verifiedTouch).toBeUndefined();
    expect(second.signupCompleted?.metadata).not.toHaveProperty('hopId');
  });

  it('binds nothing in a later visit', async () => {
    const { landing } = await redeemedHop();

    const later = await signsUp(`${VISIT_COOKIE}=${'b'.repeat(32)}; ${landing.hopCookie}; b4m_consent=granted`);

    expect(later.acquisition?.verifiedTouch).toBeUndefined();
  });

  it('binds nothing once consent is withdrawn', async () => {
    const { cookie } = await redeemedHop();

    const withdrawn = await signsUp(`${cookie}; b4m_consent=denied`);

    expect(withdrawn.acquisition).toBeUndefined();
  });

  it('binds nothing to a hop redeemed without consent, even with a hand-made cookie', async () => {
    const { hopId, token } = await sourceMints();
    const landing = await browserLands(token);
    expect(landing.hopCookie).toBeUndefined();

    const forged = await signsUp(`${VISIT_COOKIE}=${landing.visitId}; b4m_hop=${hopId}; b4m_consent=granted`);

    expect(forged.acquisition).toBeUndefined();
  });
});

describe('a verified hop, minted by the source and redeemed by this app', () => {
  it('walks mint -> redeem once -> replay refused', async () => {
    // A persona's click: the source declares its run's lane.
    const { hopId, token } = await sourceMints({
      dest: 'bike4mind',
      path: '/new',
      lane: 'synthetic',
      srcSessionId: 's-1',
    });

    expect(queued).toEqual([
      expect.objectContaining({
        productId: SOURCE,
        event: 'hop_minted',
        sessionId: 's-1',
        metadata: { hopId, dest: 'bike4mind', lane: 'synthetic' },
      }),
    ]);

    const landing = await browserLands(token, { cookie: 'b4m_consent=granted' });

    expect(landing.hopCookie).toBe(`b4m_hop=${hopId}`);
    // One hop, on the same visit id as the visit event.
    expect(visitEvents).toHaveLength(1);
    expect(visitEvents[0].sessionId).toBe(landing.visitId);
    expect(hopEvents()).toEqual([
      expect.objectContaining({
        productId: 'bike4mind',
        event: 'hop',
        sessionId: landing.visitId,
        metadata: { hopId, src: SOURCE, dest: 'bike4mind', verified: true, lane: 'synthetic' },
      }),
    ]);
    const stored = await analyticsHopRepository.findByHopId(hopId);
    expect(stored?.redeemedAt).toBeInstanceOf(Date);
    expect(stored?.redeemedSessionId).toBe(landing.visitId);

    // The same token again, from this browser or anyone holding the URL: refused, nothing sent.
    const replay = await browserLands(token, { cookie: 'b4m_consent=granted' });
    expect(replay.hopCookie).toBeUndefined();
    expect(hopEvents()).toHaveLength(1);
    expect((await analyticsHopRepository.findByHopId(hopId))?.redeemedSessionId).toBe(landing.visitId);
  });

  it('refuses a token past its 10 minutes', async () => {
    const stale = await mintHop({ dest: 'bike4mind', srcProductId: SOURCE }, new Date(Date.now() - 11 * 60_000));

    const landing = await browserLands(stale!.token, { cookie: 'b4m_consent=granted' });

    expect(landing.hopCookie).toBeUndefined();
    expect(hopEvents()).toHaveLength(0);
    expect((await analyticsHopRepository.findByHopId(stale!.hop.hopId))?.redeemedAt).toBeNull();
  });

  it('refuses a hop whose destination is not this app', async () => {
    const key = deriveHopKey('e2e-salt');
    const exp = Math.floor(Date.now() / 1000) + 300;

    // A stored hop to another product, presented with a token signed as if for this app.
    const elsewhere = 'd'.repeat(32);
    await analyticsHopRepository.create({
      hopId: elsewhere,
      srcProductId: SOURCE,
      dest: 'another-product',
      createdAt: new Date(),
    });
    const relabelled = await browserLands(signHopToken(key, { hopId: elsewhere, exp, dest: 'bike4mind' }), {
      cookie: 'b4m_consent=granted',
    });

    // A token minted for another product, presented here.
    const ours = 'e'.repeat(32);
    await analyticsHopRepository.create({
      hopId: ours,
      srcProductId: SOURCE,
      dest: 'bike4mind',
      createdAt: new Date(),
    });
    const misdirected = await browserLands(signHopToken(key, { hopId: ours, exp, dest: 'another-product' }), {
      cookie: 'b4m_consent=granted',
    });

    expect(relabelled.hopCookie).toBeUndefined();
    expect(misdirected.hopCookie).toBeUndefined();
    expect(hopEvents()).toHaveLength(0);
    expect((await analyticsHopRepository.findByHopId(elsewhere))?.redeemedAt).toBeNull();
    expect((await analyticsHopRepository.findByHopId(ours))?.redeemedAt).toBeNull();
  });

  it('refuses a forged token for a real hop', async () => {
    const { hopId, token } = await sourceMints();
    const [, exp] = token.split('.');

    const landing = await browserLands(`${hopId}.${exp}.${'A'.repeat(43)}`, { cookie: 'b4m_consent=granted' });

    expect(landing.hopCookie).toBeUndefined();
    expect(hopEvents()).toHaveLength(0);
    expect((await analyticsHopRepository.findByHopId(hopId))?.redeemedAt).toBeNull();
  });

  it('without consent, counts the hop but links no visit and sets no cookie', async () => {
    const { hopId, token } = await sourceMints();

    const landing = await browserLands(token, { cookie: 'b4m_consent=denied' });

    expect(landing.hopCookie).toBeUndefined();
    expect(hopEvents()).toHaveLength(1);
    expect(hopEvents()[0]).not.toHaveProperty('sessionId');
    expect(hopEvents()[0].metadata).toEqual({ hopId, src: SOURCE, dest: 'bike4mind', verified: true });
    const stored = await analyticsHopRepository.findByHopId(hopId);
    expect(stored?.redeemedAt).toBeInstanceOf(Date);
    expect(stored).not.toHaveProperty('redeemedSessionId');
  });
});
