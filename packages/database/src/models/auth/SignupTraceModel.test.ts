import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createMongoServer } from '../../__test__/createMongoServer';
import { SignupTraceModel, signupTraceRepository } from './SignupTraceModel';

describe('signupTraceRepository', () => {
  let server: Awaited<ReturnType<typeof createMongoServer>>;
  const until = new Date();
  const since = new Date(until.getTime() - 60 * 60 * 1000);
  const inWindow = new Date(since.getTime() + 30 * 60 * 1000);
  const input = { since, until, ipHash: 'ip-a', prefixHash: 'prefix-a', asn: 64512, maxRows: 100 };
  const trace = (accountHash: string, extra: Record<string, unknown> = {}) => ({
    accountHash,
    signedUpAt: inWindow,
    ipHash: 'ip-a',
    prefixHash: 'prefix-a',
    asn: 64512,
    ...extra,
  });

  beforeAll(async () => {
    server = await createMongoServer();
    await mongoose.connect(server.getUri());
    await SignupTraceModel.init();
  });
  beforeEach(async () => {
    await SignupTraceModel.deleteMany({});
  });
  afterAll(async () => {
    await mongoose.disconnect();
    await server.stop();
  });

  it('keeps one trace per account signup however often the purge re-runs', async () => {
    await signupTraceRepository.retain([trace('acct-1')]);
    await signupTraceRepository.retain([trace('acct-1')]);

    expect(await SignupTraceModel.countDocuments()).toBe(1);
  });

  it('counts distinct accounts per network inside the window only', async () => {
    await signupTraceRepository.retain([
      trace('acct-1'),
      trace('acct-1', { signedUpAt: new Date(inWindow.getTime() + 1000) }),
      trace('acct-2', { ipHash: 'ip-b' }),
      trace('acct-3', { ipHash: 'ip-c', prefixHash: 'prefix-c', asn: 64999 }),
      trace('acct-4', { signedUpAt: new Date(since.getTime() - 1000) }),
    ]);

    expect(await signupTraceRepository.recentDistinctSignups(input)).toEqual({
      ipSignups: 1,
      prefixSignups: 2,
      asnSignups: 2,
    });
  });

  it('skips a count it was not asked for and reports a truncated scan as unknown', async () => {
    await signupTraceRepository.retain([trace('acct-1'), trace('acct-2')]);

    expect(
      await signupTraceRepository.recentDistinctSignups({ ...input, prefixHash: null, asn: null, maxRows: 1 })
    ).toEqual({ ipSignups: null, prefixSignups: null, asnSignups: null });
    expect(
      await signupTraceRepository.recentDistinctSignups({ ...input, ipHash: null, prefixHash: null, asn: 0 })
    ).toEqual({ ipSignups: null, prefixSignups: null, asnSignups: null });
  });

  it('expires traces two days after the signup', async () => {
    const indexes = await SignupTraceModel.collection.indexes();
    expect(indexes.find(index => Object.keys(index.key).join() === 'signedUpAt')).toMatchObject({
      expireAfterSeconds: 2 * 24 * 60 * 60,
    });
  });

  it('indexes each network count by network then time', async () => {
    const keys = (await SignupTraceModel.collection.indexes()).map(index => Object.keys(index.key).join());
    expect(keys).toEqual(expect.arrayContaining(['ipHash,signedUpAt', 'prefixHash,signedUpAt', 'asn,signedUpAt']));
  });
});
