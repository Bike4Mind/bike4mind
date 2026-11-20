import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createMongoServer } from '../../__test__/createMongoServer';
import { Subscriber, subscriberRepository } from './SubscriberModel';

describe('Subscriber email normalization', () => {
  let server: Awaited<ReturnType<typeof createMongoServer>>;
  const base = { firstName: 'Ada', lastName: 'Lovelace' };

  beforeAll(async () => {
    server = await createMongoServer();
    await mongoose.connect(server.getUri());
    await Subscriber.init();
  });
  beforeEach(async () => {
    await Subscriber.deleteMany({});
  });
  afterAll(async () => {
    await mongoose.disconnect();
    await server?.stop();
  });

  it('stores the email trimmed and lowercased', async () => {
    const doc = await Subscriber.create({ ...base, email: '  Ada.Lovelace@Example.COM ' });

    const raw = await Subscriber.collection.findOne({ _id: doc._id });
    expect(raw?.email).toBe('ada.lovelace@example.com');
  });

  it('rejects a case variant of an existing address via the unique index', async () => {
    await Subscriber.create({ ...base, email: 'ada@example.com' });

    await expect(Subscriber.create({ ...base, email: 'ADA@Example.com' })).rejects.toMatchObject({ code: 11000 });
  });

  it('normalizes the email in query filters', async () => {
    await Subscriber.create({ ...base, email: 'ada@example.com' });

    const found = await Subscriber.findOne({ email: ' ADA@example.COM', deletedAt: null });
    expect(found?.email).toBe('ada@example.com');
  });

  it('findByEmail matches regardless of case and surrounding whitespace', async () => {
    await Subscriber.create({ ...base, email: 'ada@example.com' });

    const found = await subscriberRepository.findByEmail(' Ada@Example.com ');
    expect(found?.email).toBe('ada@example.com');
  });

  describe('signup network and suspicious flag', () => {
    const network = (capturedAt: Date) => ({
      ipPrefix: '203.0.113.0',
      userAgent: 'curl/8',
      asn: 64500,
      asnOrg: null,
      country: 'US',
      isDatacenter: true,
      ja4: null,
      wafAnonIp: true,
      wafBotSignal: null,
      challengeVerified: true as const,
      capturedAt,
    });

    it('round-trips the network and reasons, and leaves both absent on a legacy row', async () => {
      const captured = new Date('2026-10-30T00:00:00Z');
      const flagged = await Subscriber.create({
        ...base,
        email: 'probe@example.com',
        signupNetwork: network(captured),
        suspicious: { reasons: ['markup', 'formula_prefix'] },
      });
      const legacy = await Subscriber.create({ ...base, email: 'legacy@example.com' });

      const [found] = (await subscriberRepository.listSubscribers({ page: 1, limit: 10, search: 'probe' })).data;
      expect(found.signupNetwork).toEqual(network(captured));
      expect(found.suspicious).toEqual({ reasons: ['markup', 'formula_prefix'] });
      const raw = await Subscriber.collection.findOne({ _id: legacy._id });
      expect(raw).not.toHaveProperty('signupNetwork');
      expect(raw).not.toHaveProperty('suspicious');
      expect(flagged.id).toBeTruthy();
    });

    it('rejects an unknown suspicious reason', async () => {
      await expect(
        Subscriber.create({ ...base, email: 'x@example.com', suspicious: { reasons: ['nope' as 'markup'] } })
      ).rejects.toThrow();
    });

    it('clears only network captured before the cutoff, keeping the row and its updatedAt', async () => {
      const old = await Subscriber.create({
        ...base,
        email: 'old@example.com',
        signupNetwork: network(new Date('2026-07-01T00:00:00Z')),
      });
      const fresh = await Subscriber.create({
        ...base,
        email: 'fresh@example.com',
        signupNetwork: network(new Date('2026-10-30T00:00:00Z')),
      });

      const cleared = await subscriberRepository.clearSignupNetworkBefore(new Date('2026-08-08T00:00:00Z'));

      expect(cleared).toBe(1);
      const oldRaw = await Subscriber.collection.findOne({ _id: old._id });
      expect(oldRaw?.signupNetwork).toBeNull();
      expect(oldRaw?.email).toBe('old@example.com');
      expect(oldRaw?.updatedAt).toEqual(old.updatedAt);
      const freshRaw = await Subscriber.collection.findOne({ _id: fresh._id });
      expect(freshRaw?.signupNetwork?.ipPrefix).toBe('203.0.113.0');
    });
  });
});
