import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer } from '../../__test__/createMongoServer';
import { claimCreditGrantIdentity, CreditGrantIdentityClaim } from './CreditGrantIdentityClaimModel';

let server: Awaited<ReturnType<typeof createMongoServer>>;
const binding = { identityDigest: 'a'.repeat(64), ownerId: 'synthetic-owner', transactionId: 'synthetic-grant' };

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri(), { autoIndex: false });
  await CreditGrantIdentityClaim.createCollection();
  await CreditGrantIdentityClaim.createIndexes();
});

beforeEach(async () => {
  await CreditGrantIdentityClaim.deleteMany({});
});

afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});

describe('claimCreditGrantIdentity', () => {
  it('accepts an exact replay after a posting failure without creating another claim', async () => {
    expect(await claimCreditGrantIdentity(binding)).toBe(true);
    expect(await claimCreditGrantIdentity(binding)).toBe(true);
    expect(await CreditGrantIdentityClaim.countDocuments()).toBe(1);
  });

  it('allows only one account to claim an identity under parallel requests', async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        claimCreditGrantIdentity({
          ...binding,
          ownerId: `synthetic-owner-${i}`,
          transactionId: `synthetic-grant-${i}`,
        })
      )
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await CreditGrantIdentityClaim.countDocuments()).toBe(1);
  });

  it('rejects alternate transaction keys for the same identity and account', async () => {
    const results = await Promise.all(
      ['synthetic-arm-a', 'synthetic-arm-b'].map(transactionId =>
        claimCreditGrantIdentity({ ...binding, transactionId })
      )
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('prevents an account from binding multiple identities concurrently', async () => {
    const results = await Promise.all(
      ['b', 'c'].map(char =>
        claimCreditGrantIdentity({
          ...binding,
          identityDigest: char.repeat(64),
          transactionId: `synthetic-grant-${char}`,
        })
      )
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('does not reuse a ledger key for another identity or account', async () => {
    await claimCreditGrantIdentity(binding);
    expect(
      await claimCreditGrantIdentity({
        ...binding,
        identityDigest: 'b'.repeat(64),
        ownerId: 'synthetic-other',
      })
    ).toBe(false);
  });

  it('supports concurrent exact retries with one durable binding', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => claimCreditGrantIdentity(binding)));
    expect(results.every(Boolean)).toBe(true);
    expect(await CreditGrantIdentityClaim.countDocuments()).toBe(1);
  });

  it('recovers from a lost acknowledgement after the insert committed', async () => {
    await CreditGrantIdentityClaim.create(binding);
    expect(await claimCreditGrantIdentity(binding)).toBe(true);
  });

  it('propagates database failures instead of treating them as successful claims', async () => {
    const write = vi
      .spyOn(CreditGrantIdentityClaim, 'create')
      .mockRejectedValueOnce(new Error('synthetic write failure'));
    try {
      await expect(claimCreditGrantIdentity(binding)).rejects.toThrow('synthetic write failure');
    } finally {
      write.mockRestore();
    }
    expect(await claimCreditGrantIdentity(binding)).toBe(true);
  });

  it.each(['identityDigest', 'ownerId', 'transactionId'])(
    'refuses to write without the unique %s index even with autoIndex disabled',
    async field => {
      await CreditGrantIdentityClaim.collection.dropIndex(`${field}_1`);
      try {
        await expect(claimCreditGrantIdentity(binding)).rejects.toThrow('indexes are not ready');
        expect(await CreditGrantIdentityClaim.countDocuments()).toBe(0);
      } finally {
        await CreditGrantIdentityClaim.createIndexes();
      }
    }
  );

  it('refuses expiring claim storage', async () => {
    await CreditGrantIdentityClaim.collection.createIndex({ createdAt: 1 }, { expireAfterSeconds: 3600 });
    try {
      await expect(claimCreditGrantIdentity(binding)).rejects.toThrow('must not expire');
      expect(await CreditGrantIdentityClaim.countDocuments()).toBe(0);
    } finally {
      await CreditGrantIdentityClaim.collection.dropIndex('createdAt_1');
    }
  });

  it.each([
    { ...binding, identityDigest: 'not-a-digest' },
    { ...binding, ownerId: '' },
    { ...binding, transactionId: '' },
  ])('refuses invalid bindings before writing', async claim => {
    await expect(claimCreditGrantIdentity(claim)).rejects.toThrow();
    expect(await CreditGrantIdentityClaim.countDocuments()).toBe(0);
  });

  it('stores only the binding and timestamps, without caller-supplied evidence', async () => {
    await claimCreditGrantIdentity({ ...binding, evidence: 'synthetic-extra' } as typeof binding);
    const stored = await CreditGrantIdentityClaim.findOne().lean();
    expect(Object.keys(stored!).sort()).toEqual([
      '__v',
      '_id',
      'createdAt',
      'identityDigest',
      'ownerId',
      'transactionId',
      'updatedAt',
    ]);
  });
});
