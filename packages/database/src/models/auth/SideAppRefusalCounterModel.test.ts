import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createMongoServer } from '../../__test__/createMongoServer';
import { SideAppRefusalCounter, sideAppRefusalCounterRepository } from './SideAppRefusalCounterModel';
import { SideAppRefusal, sideAppRefusalRepository } from './SideAppRefusalModel';

describe('side app refusal models', () => {
  let server: Awaited<ReturnType<typeof createMongoServer>>;

  beforeAll(async () => {
    server = await createMongoServer();
    await mongoose.connect(server.getUri());
    await SideAppRefusalCounter.init();
    await SideAppRefusal.init();
  });
  beforeEach(async () => {
    await SideAppRefusalCounter.deleteMany({});
    await SideAppRefusal.deleteMany({});
  });
  afterAll(async () => {
    await mongoose.disconnect();
    await server?.stop();
  });

  it('keeps one counter row per hour and reason however many increments arrive', async () => {
    const at = new Date('2026-11-15T10:42:17.000Z');
    await Promise.all(
      Array.from({ length: 50 }, () => sideAppRefusalCounterRepository.increment('invalid_client', at))
    );
    await sideAppRefusalCounterRepository.increment('invalid_client', new Date('2026-11-15T10:59:59.000Z'));
    await sideAppRefusalCounterRepository.increment('invalid_client', new Date('2026-11-15T11:00:00.000Z'));
    await sideAppRefusalCounterRepository.increment('invalid_request', at);

    const rows = await SideAppRefusalCounter.find({}).sort({ hour: 1, reason: 1 }).lean();
    expect(rows.map(r => [r.hour.toISOString(), r.reason, r.count])).toEqual([
      ['2026-11-15T10:00:00.000Z', 'invalid_client', 51],
      ['2026-11-15T10:00:00.000Z', 'invalid_request', 1],
      ['2026-11-15T11:00:00.000Z', 'invalid_client', 1],
    ]);
    expect(Object.keys(rows[0]).sort()).toEqual(['_id', 'count', 'hour', 'reason']);
  });

  it('stores a verified refusal with its identifiers', async () => {
    await sideAppRefusalRepository.record({
      clientId: 'app-1',
      stage: 'use',
      reason: 'subscription_required',
      status: 403,
      userId: 'u1',
      keyId: 'k1',
      endpoint: '/api/chat',
    });
    const rows = await SideAppRefusal.find({}).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ clientId: 'app-1', stage: 'use', status: 403, keyId: 'k1' });
    expect(rows[0].createdAt).toBeInstanceOf(Date);
  });

  it('declares 90 day TTL indexes', async () => {
    const ttl = async (m: typeof SideAppRefusal | typeof SideAppRefusalCounter) =>
      (await m.collection.indexes()).find(i => i.expireAfterSeconds !== undefined)?.expireAfterSeconds;
    expect(await ttl(SideAppRefusal)).toBe(90 * 24 * 60 * 60);
    expect(await ttl(SideAppRefusalCounter)).toBe(90 * 24 * 60 * 60);
  });
});
