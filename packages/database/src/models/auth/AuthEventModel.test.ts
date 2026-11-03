import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createMongoServer } from '../../__test__/createMongoServer';
import { AuthEventModel, authEventRepository } from './AuthEventModel';

describe('recentDistinctSignups', () => {
  let server: Awaited<ReturnType<typeof createMongoServer>>;
  const until = new Date();
  const since = new Date(until.getTime() - 60 * 60 * 1000);
  const input = { userId: 'current', since, until, ip: '192.0.2.1', asn: 64512, maxRows: 100 };
  const row = (userId: string, extra: Record<string, unknown> = {}) => ({
    userId,
    type: 'signup',
    method: 'synthetic',
    ip: '192.0.2.1',
    asn: 64512,
    createdAt: new Date(since.getTime() + 30 * 60 * 1000),
    ...extra,
  });

  beforeAll(async () => {
    server = await createMongoServer();
    await mongoose.connect(server.getUri());
    await AuthEventModel.init();
  });
  beforeEach(async () => {
    await AuthEventModel.deleteMany({});
  });
  afterAll(async () => {
    await mongoose.disconnect();
    await server?.stop();
  });

  it('deduplicates retries, ignores logins and the current account, and uses half-open windows', async () => {
    await AuthEventModel.collection.insertMany([
      row('one'),
      row('one'),
      row('current'),
      row('login', { type: 'login' }),
      row('start', { createdAt: since }),
      row('end', { createdAt: until }),
      row('old', { createdAt: new Date(since.getTime() - 1) }),
      row('prefix', { ip: '192.0.2.99' }),
      row('asn', { ip: '198.51.100.1' }),
      row('outside', { ip: '192.0.20.1', asn: 64513 }),
    ]);
    expect(await authEventRepository.recentDistinctSignups(input)).toEqual({
      ipSignups: 2,
      asnSignups: 4,
      prefixSignups: 3,
    });
  });

  it('counts every account when no userId is given', async () => {
    await AuthEventModel.collection.insertMany([row('one'), row('current')]);
    const { userId: _omitted, ...withoutUser } = input;
    expect(await authEventRepository.recentDistinctSignups(withoutUser)).toMatchObject({ ipSignups: 2 });
  });

  it('skips the /24 count when the caller opts out', async () => {
    await AuthEventModel.collection.insertMany([row('one'), row('prefix', { ip: '192.0.2.99' })]);
    expect(await authEventRepository.recentDistinctSignups({ ...input, prefix: false })).toMatchObject({
      ipSignups: 1,
      prefixSignups: null,
    });
  });

  it('returns unknown on missing metadata or scan saturation', async () => {
    expect(await authEventRepository.recentDistinctSignups({ ...input, ip: null, asn: null })).toEqual({
      ipSignups: null,
      asnSignups: null,
      prefixSignups: null,
    });
    await AuthEventModel.collection.insertMany([row('one'), row('one'), row('two')]);
    expect(await authEventRepository.recentDistinctSignups({ ...input, maxRows: 2 })).toEqual({
      ipSignups: null,
      asnSignups: null,
      prefixSignups: null,
    });
  });

  it('does not invent IPv6 prefix observations', async () => {
    expect(await authEventRepository.recentDistinctSignups({ ...input, ip: '2001:db8::1' })).toEqual({
      ipSignups: 0,
      asnSignups: 0,
      prefixSignups: null,
    });
  });

  it.each(['', 'unknown', 'not-an-ip', '999.0.2.1', '192.000.2.1', ' 192.0.2.1'])(
    'keeps invalid IP %s unknown instead of reporting a clean network',
    async ip => {
      expect(await authEventRepository.recentDistinctSignups({ ...input, ip })).toEqual({
        ipSignups: null,
        asnSignups: 0,
        prefixSignups: null,
      });
    }
  );

  it('excludes the current account before applying the scan limit', async () => {
    await AuthEventModel.collection.insertMany([row('current'), row('current'), row('other')]);
    expect(await authEventRepository.recentDistinctSignups({ ...input, maxRows: 1 })).toEqual({
      ipSignups: 1,
      asnSignups: 1,
      prefixSignups: 1,
    });
  });

  it('rejects short windows whose observations have already expired', async () => {
    const expiredUntil = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000);
    await expect(
      authEventRepository.recentDistinctSignups({
        ...input,
        since: new Date(expiredUntil.getTime() - 60 * 60 * 1000),
        until: expiredUntil,
      })
    ).rejects.toThrow('Invalid signup window');
  });

  it('rejects unbounded or invalid windows', async () => {
    for (const patch of [
      { maxRows: 0 },
      { maxRows: 10001 },
      { since: until },
      { since: new Date(NaN) },
      { until: new Date(Date.now() + 60 * 60 * 1000) },
      { until: new Date(until.getTime() + 365 * 24 * 60 * 60 * 1000) },
    ]) {
      await expect(authEventRepository.recentDistinctSignups({ ...input, ...patch })).rejects.toThrow(
        'Invalid signup window'
      );
    }
  });
});
