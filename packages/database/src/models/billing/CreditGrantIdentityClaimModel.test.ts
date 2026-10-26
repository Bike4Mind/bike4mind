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
  it('returns true for an exact replay without a second claim', async () => {
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
    const stored = await CreditGrantIdentityClaim.findOne().lean();
    expect(stored?.ownerId).toBe(`synthetic-owner-${results.indexOf(true)}`);
  });

  it('rejects alternate transaction keys for the same identity and account', async () => {
    const results = await Promise.all(
      ['synthetic-arm-a', 'synthetic-arm-b'].map(transactionId =>
        claimCreditGrantIdentity({ ...binding, transactionId })
      )
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await CreditGrantIdentityClaim.countDocuments()).toBe(1);
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
    expect(await CreditGrantIdentityClaim.countDocuments()).toBe(1);
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

  it.each([
    ['sparse', { unique: true, sparse: true }],
    ['partial', { unique: true, partialFilterExpression: { ownerId: { $type: 'string' } } }],
  ])('refuses a %s unique index', async (_name, options) => {
    await CreditGrantIdentityClaim.collection.dropIndex('ownerId_1');
    await CreditGrantIdentityClaim.collection.createIndex({ ownerId: 1 }, options);
    try {
      await expect(claimCreditGrantIdentity(binding)).rejects.toThrow('indexes are not ready');
      expect(await CreditGrantIdentityClaim.countDocuments()).toBe(0);
    } finally {
      await CreditGrantIdentityClaim.collection.dropIndex('ownerId_1');
      await CreditGrantIdentityClaim.createIndexes();
    }
  });

  it('refuses a compound unique index in place of a single-field one', async () => {
    await CreditGrantIdentityClaim.collection.dropIndex('transactionId_1');
    await CreditGrantIdentityClaim.collection.createIndex({ transactionId: 1, ownerId: 1 }, { unique: true });
    try {
      await expect(claimCreditGrantIdentity(binding)).rejects.toThrow('indexes are not ready');
      expect(await CreditGrantIdentityClaim.countDocuments()).toBe(0);
    } finally {
      await CreditGrantIdentityClaim.collection.dropIndex('transactionId_1_ownerId_1');
      await CreditGrantIdentityClaim.createIndexes();
    }
  });

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

describe('claimCreditGrantIdentity on a database without the collection', () => {
  it('reports missing indexes instead of a raw namespace error', async () => {
    await CreditGrantIdentityClaim.collection.drop();
    mongoose.deleteModel('CreditGrantIdentityClaim');
    vi.resetModules();
    const fresh = await import('./CreditGrantIdentityClaimModel');
    await expect(fresh.claimCreditGrantIdentity(binding)).rejects.toThrow('indexes are not ready');
    await fresh.CreditGrantIdentityClaim.createIndexes();
    expect(await fresh.claimCreditGrantIdentity(binding)).toBe(true);
  });
});
