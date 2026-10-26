import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { signupMetaSchema } from '@bike4mind/common';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../__test__/createMongoServer';
import { User } from './UserModel';
import { AuthEventModel } from './AuthEventModel';
import { findSignupFingerprintClusters } from './signupFingerprintClusters';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
const fingerprint = 't13d0101h2_111111111111_222222222222';
const other = 't13d0202h2_333333333333_444444444444';
const start = new Date('2025-01-01T00:00:00Z');
const end = new Date('2025-01-02T00:00:00Z');
const meta = {
  ip: null,
  userAgent: null,
  asn: null,
  asnOrg: null,
  country: null,
  isDatacenter: null,
  capturedAt: start,
};
const query = { windowStart: start, windowEnd: end, minimumSignups: 2, excludedFingerprints: [], limit: 10 };

describe('signup fingerprint observations', () => {
  let server: Awaited<ReturnType<typeof createMongoServer>>;
  beforeAll(async () => {
    server = await createMongoServer();
    await mongoose.connect(server.getUri(), { autoIndex: false });
    await User.collection.createIndex(
      { createdAt: 1, 'signupMeta.ja4': 1 },
      { name: 'user_signup_fingerprint_window' }
    );
  });
  afterAll(async () => {
    await mongoose.disconnect();
    await server?.stop();
  });
  beforeEach(async () => {
    await User.collection.deleteMany({});
    await AuthEventModel.collection.deleteMany({});
  });

  it('keeps Zod and both persistence schemas aligned for optional and malformed values', async () => {
    for (const ja4 of [
      undefined,
      null,
      fingerprint,
      fingerprint.replace('h2', 'H2'),
      '',
      'x'.repeat(39),
      [fingerprint],
    ]) {
      const data = { ...meta, ja4 };
      const user = new User({ username: 'sample', name: 'Sample', signupMeta: data });
      const event = new AuthEventModel({ ...data, userId: 'sample', type: 'signup', method: 'test' });
      const valid = signupMetaSchema.safeParse(data).success;
      expect(!user.validateSync()).toBe(valid);
      expect(!event.validateSync()).toBe(valid);
    }
    const saved = await User.create({ username: 'sample', name: 'Sample', signupMeta: { ...meta, ja4: fingerprint } });
    expect((await User.findById(saved._id))?.signupMeta?.ja4).toBe(fingerprint);
  });

  it('counts distinct recent user records with half-open window boundaries and repeatable results', async () => {
    await User.collection.insertMany([
      { createdAt: start, deletedAt: null, signupMeta: { ...meta, ja4: fingerprint } },
      { createdAt: new Date(start.getTime() + 1), deletedAt: null, signupMeta: { ...meta, ja4: fingerprint } },
      { createdAt: end, deletedAt: null, signupMeta: { ...meta, ja4: fingerprint } },
      { createdAt: new Date(start.getTime() - 1), deletedAt: null, signupMeta: { ...meta, ja4: fingerprint } },
      { createdAt: start, deletedAt: null, signupMeta: { ...meta, ja4: other } },
      { createdAt: start, deletedAt: null },
      ...Array.from({ length: 3 }, () => ({ createdAt: start, signupMeta: { ja4: 'invalid-legacy-value' } })),
    ]);
    await AuthEventModel.create(
      Array.from({ length: 4 }, () => ({ ...meta, ja4: fingerprint, userId: 'retry', type: 'login', method: 'test' }))
    );
    const expected = [{ ja4: fingerprint, signupCount: 2, windowStart: start, windowEnd: end }];
    expect(await findSignupFingerprintClusters(query)).toEqual(expected);
    expect(await findSignupFingerprintClusters({ ...query, limit: 1 })).toEqual(expected);
    expect(await findSignupFingerprintClusters(query)).toEqual(expected);
    expect(await findSignupFingerprintClusters({ ...query, excludedFingerprints: [fingerprint] })).toEqual([]);
    expect(await findSignupFingerprintClusters({ ...query, minimumSignups: 3 })).toEqual([]);
  });

  it.each([
    ['array', [fingerprint]],
    ['mixed array', ['invalid', fingerprint]],
    ['trailing newline', `${fingerprint}\n`],
    ['trailing carriage return', `${fingerprint}\r`],
    ['object', { value: fingerprint }],
    ['number', 123],
    ['null', null],
  ])('rejects malformed legacy %s values before applying the limit', async (_name, ja4) => {
    await User.collection.insertMany([
      ...Array.from({ length: 3 }, () => ({ createdAt: start, signupMeta: { ja4 } })),
      ...Array.from({ length: 2 }, () => ({ createdAt: start, signupMeta: { ja4: fingerprint } })),
    ]);
    expect(await findSignupFingerprintClusters({ ...query, limit: 1 })).toEqual([
      { ja4: fingerprint, signupCount: 2, windowStart: start, windowEnd: end },
    ]);
  });

  it('preserves uppercase ALPN values through persistence, grouping and exclusions', async () => {
    const uppercaseFingerprint = fingerprint.replace('h2', 'H2');
    for (const username of ['first', 'second']) {
      await User.create({ username, name: username, signupMeta: { ...meta, ja4: uppercaseFingerprint } });
    }
    const recentQuery = {
      ...query,
      windowStart: new Date(Date.now() - 60_000),
      windowEnd: new Date(Date.now() + 60_000),
    };
    expect(await findSignupFingerprintClusters(recentQuery)).toEqual([
      {
        ja4: uppercaseFingerprint,
        signupCount: 2,
        windowStart: recentQuery.windowStart,
        windowEnd: recentQuery.windowEnd,
      },
    ]);
    expect(
      await findSignupFingerprintClusters({ ...recentQuery, excludedFingerprints: [uppercaseFingerprint] })
    ).toEqual([]);
  });

  it('orders tied clusters by fingerprint and includes retained soft-deleted signups', async () => {
    await User.collection.insertMany([
      { createdAt: start, signupMeta: { ja4: other } },
      { createdAt: start, signupMeta: { ja4: other } },
      { createdAt: start, signupMeta: { ja4: fingerprint } },
      { createdAt: start, deletedAt: start, signupMeta: { ja4: fingerprint } },
    ]);
    expect(await findSignupFingerprintClusters(query)).toEqual([
      { ja4: fingerprint, signupCount: 2, windowStart: start, windowEnd: end },
      { ja4: other, signupCount: 2, windowStart: start, windowEnd: end },
    ]);
    expect(await findSignupFingerprintClusters({ ...query, limit: 1 })).toEqual([
      { ja4: fingerprint, signupCount: 2, windowStart: start, windowEnd: end },
    ]);
  });

  it('rejects invalid windows and unbounded result sizes before querying', async () => {
    await expect(findSignupFingerprintClusters({ ...query, windowEnd: start })).rejects.toThrow();
    await expect(findSignupFingerprintClusters({ ...query, limit: 1001 })).rejects.toThrow();
    const ninetyDaysMs = 90 * 24 * 60 * 60_000;
    await expect(
      findSignupFingerprintClusters({ ...query, windowEnd: new Date(start.getTime() + ninetyDaysMs + 1) })
    ).rejects.toThrow();
    await expect(
      findSignupFingerprintClusters({ ...query, windowEnd: new Date(start.getTime() + ninetyDaysMs) })
    ).resolves.toEqual([]);
    await expect(findSignupFingerprintClusters({ ...query, minimumSignups: 0 })).rejects.toThrow();
  });
});
