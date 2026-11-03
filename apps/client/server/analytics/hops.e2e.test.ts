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
import { AnalyticsHop, analyticsHopRepository } from '@bike4mind/database';
import { ApiKeyScope } from '@bike4mind/common';
import { mintHop } from './hops';
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
