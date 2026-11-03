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
});
