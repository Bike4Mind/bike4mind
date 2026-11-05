import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoServer } from '../../__test__/createMongoServer';
import { AnalyticsHop, analyticsHopRepository, type AnalyticsHopInput } from './AnalyticsHopModel';

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

afterEach(async () => {
  await AnalyticsHop.deleteMany({});
});

const MINTED_AT = new Date('2026-11-03T12:00:00.000Z');
const SOON = new Date(MINTED_AT.getTime() + 60_000);
const WINDOW_START = new Date(MINTED_AT.getTime() - 60_000);

const hop = (over: Partial<AnalyticsHopInput> = {}): AnalyticsHopInput => ({
  hopId: 'a'.repeat(32),
  srcProductId: 'source-product',
  dest: 'bike4mind',
  createdAt: MINTED_AT,
  expiresAt: new Date(MINTED_AT.getTime() + 90 * 86_400_000),
  ...over,
});

const redeem = (over: Partial<Parameters<typeof analyticsHopRepository.redeem>[0]> = {}) =>
  analyticsHopRepository.redeem({
    hopId: 'a'.repeat(32),
    dest: 'bike4mind',
    now: SOON,
    mintedSince: WINDOW_START,
    ...over,
  });

describe('analyticsHopRepository', () => {
  it('stores a new hop unredeemed', async () => {
    const created = await analyticsHopRepository.create(hop({ path: '/new', lane: 'synthetic' }));
    expect(created.redeemedAt).toBeNull();
    const stored = await analyticsHopRepository.findByHopId('a'.repeat(32));
    expect(stored).toMatchObject({
      srcProductId: 'source-product',
      dest: 'bike4mind',
      path: '/new',
      lane: 'synthetic',
    });
  });

  it('rejects a second hop with the same id', async () => {
    await analyticsHopRepository.create(hop());
    await expect(analyticsHopRepository.create(hop())).rejects.toThrow(/duplicate key/);
  });

  it('redeems once: the second redeem of the same hop matches nothing', async () => {
    await analyticsHopRepository.create(hop());
    const first = await redeem({ sessionId: 'f'.repeat(32) });
    expect(first?.redeemedAt).toEqual(SOON);
    expect(first?.redeemedSessionId).toBe('f'.repeat(32));
    expect(await redeem({ sessionId: 'e'.repeat(32) })).toBeNull();
    // The first redeem's visit stands.
    expect((await analyticsHopRepository.findByHopId('a'.repeat(32)))?.redeemedSessionId).toBe('f'.repeat(32));
  });

  it('lets exactly one of several concurrent redeems through', async () => {
    await analyticsHopRepository.create(hop());
    const results = await Promise.all(Array.from({ length: 8 }, () => redeem()));
    expect(results.filter(r => r !== null)).toHaveLength(1);
  });

  it('refuses a hop minted for another destination', async () => {
    await analyticsHopRepository.create(hop({ dest: 'another-product' }));
    expect(await redeem()).toBeNull();
    expect((await analyticsHopRepository.findByHopId('a'.repeat(32)))?.redeemedAt).toBeNull();
  });

  it('refuses a hop minted before the redeem window', async () => {
    await analyticsHopRepository.create(hop());
    expect(await redeem({ mintedSince: new Date(MINTED_AT.getTime() + 1) })).toBeNull();
  });

  it('refuses an unknown hop', async () => {
    expect(await redeem({ hopId: 'b'.repeat(32) })).toBeNull();
  });

  it('records no visit when none is given', async () => {
    await analyticsHopRepository.create(hop());
    const redeemed = await redeem();
    expect(redeemed?.redeemedAt).toEqual(SOON);
    expect(redeemed).not.toHaveProperty('redeemedSessionId');
  });

  describe('bindToSignup', () => {
    const VISIT = 'f'.repeat(32);
    const LATER = new Date(SOON.getTime() + 5 * 60_000);
    const bind = (over: Partial<Parameters<typeof analyticsHopRepository.bindToSignup>[0]> = {}) =>
      analyticsHopRepository.bindToSignup({
        hopId: 'a'.repeat(32),
        dest: 'bike4mind',
        sessionId: VISIT,
        now: LATER,
        redeemedSince: WINDOW_START,
        ...over,
      });

    it('binds a hop redeemed in the same visit, once, and keeps it from then on', async () => {
      await analyticsHopRepository.create(hop());
      await redeem({ sessionId: VISIT });

      const bound = await bind();
      expect(bound?.boundAt).toEqual(LATER);
      expect(bound).not.toHaveProperty('expiresAt');
      expect(await bind({ now: new Date(LATER.getTime() + 1000) })).toBeNull();
      expect((await analyticsHopRepository.findByHopId('a'.repeat(32)))?.boundAt).toEqual(LATER);
    });

    it('lets exactly one of several concurrent signups take the hop', async () => {
      await analyticsHopRepository.create(hop());
      await redeem({ sessionId: VISIT });
      const results = await Promise.all(Array.from({ length: 6 }, () => bind()));
      expect(results.filter(r => r !== null)).toHaveLength(1);
    });

    it('refuses a signup in another visit', async () => {
      await analyticsHopRepository.create(hop());
      await redeem({ sessionId: VISIT });
      expect(await bind({ sessionId: 'e'.repeat(32) })).toBeNull();
    });

    it('refuses a hop redeemed with no visit, or never redeemed', async () => {
      await analyticsHopRepository.create(hop());
      expect(await bind()).toBeNull();
      await redeem();
      expect(await bind()).toBeNull();
    });

    it('refuses a hop redeemed before the binding window', async () => {
      await analyticsHopRepository.create(hop());
      await redeem({ sessionId: VISIT });
      expect(await bind({ redeemedSince: new Date(SOON.getTime() + 1) })).toBeNull();
    });

    it('refuses a hop for another destination', async () => {
      await analyticsHopRepository.create(hop());
      await redeem({ sessionId: VISIT });
      expect(await bind({ dest: 'another-product' })).toBeNull();
    });
  });

  it('indexes hopId uniquely and sweeps on expiresAt', async () => {
    const indexes = await AnalyticsHop.collection.indexes();
    const ttl = indexes.find(i => i.key.expiresAt === 1);
    expect(ttl?.expireAfterSeconds).toBe(0);
    expect(indexes.find(i => i.key.hopId === 1)?.unique).toBe(true);
  });
});
