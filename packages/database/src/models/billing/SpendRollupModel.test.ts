import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoServer } from '../../__test__/createMongoServer';
import { CreditHolderType, SPEND_BUCKET_MS } from '@bike4mind/common';
import { CreditTransaction } from './CreditTransactionModel';
import { UsageEvent } from './UsageEventModel';
import { SpendRollup, ledgerUsageMatch, spendRollupRepository } from './SpendRollupModel';

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await createMongoServer();
  await mongoose.connect(mongod.getUri());
  await SpendRollup.syncIndexes();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

afterEach(async () => {
  await Promise.all([SpendRollup.deleteMany({}), CreditTransaction.deleteMany({}), UsageEvent.deleteMany({})]);
});

const bucketStart = new Date('2026-10-30T12:00:00.000Z');
const inBucket = new Date(bucketStart.getTime() + 60_000);

const deduct = (
  ownerType: CreditHolderType,
  ownerId: string,
  credits: number,
  extra: { model?: string; apiKeyId?: string; createdAt?: Date; type?: string } = {}
) => ({
  ownerId,
  ownerType,
  type: 'text_generation_usage',
  credits,
  createdAt: inBucket,
  ...extra,
});

const usageEvent = (costUsd: number, extra: Record<string, unknown> = {}) => ({
  requestId: `req-${Math.random()}`,
  userId: 'user-a',
  ownerId: 'user-a',
  ownerType: CreditHolderType.User,
  feature: 'chat',
  provider: 'bedrock',
  model: 'm1',
  costUsd,
  creditsCharged: 10,
  status: 'ok',
  createdAt: inBucket,
  ...extra,
});

const findRollup = (scopeType: string, scopeId: string) =>
  SpendRollup.findOne({ bucketStart, scopeType, scopeId }).lean();

describe('SpendRollupRepository.rollupBucket', () => {
  it('rolls usage credits per platform, owner, apiKey and model', async () => {
    await CreditTransaction.insertMany([
      deduct(CreditHolderType.User, 'user-a', -100, { model: 'm1', apiKeyId: 'K1', type: 'completion_api_usage' }),
      deduct(CreditHolderType.User, 'user-a', -50, { model: 'm2' }),
      deduct(CreditHolderType.Organization, 'org-o', -30, { model: 'm1' }),
      { ownerId: 'user-a', ownerType: CreditHolderType.User, type: 'purchase', credits: 1000, createdAt: inBucket },
    ]);

    await spendRollupRepository.rollupBucket(bucketStart);

    // Only the completion_api_usage row is a request; text_generation_usage rows add credits only.
    expect(await findRollup('platform', 'all')).toMatchObject({ credits: 180, requests: 1 });
    expect(await findRollup('User', 'user-a')).toMatchObject({ credits: 150, requests: 1 });
    expect(await findRollup('Organization', 'org-o')).toMatchObject({ credits: 30, requests: 0 });
    expect(await findRollup('apiKey', 'K1')).toMatchObject({ credits: 100, requests: 1 });
    expect(await findRollup('model', 'm1')).toMatchObject({ credits: 130, requests: 1 });
    expect(await findRollup('model', 'm2')).toMatchObject({ credits: 50 });
    // platform + user-a + org-o + K1 + m1 + m2; the purchase adds nothing.
    expect(await SpendRollup.countDocuments({ bucketStart })).toBe(6);
  });

  it('adds UsageEvent cost to platform and model, including bypassed rows', async () => {
    await UsageEvent.insertMany([
      usageEvent(1.5),
      usageEvent(0.5, { creditsCharged: 0, writtenOffCredits: 10, status: 'refusal' }),
    ]);

    await spendRollupRepository.rollupBucket(bucketStart);

    expect(await findRollup('platform', 'all')).toMatchObject({ costUsd: 2, creditsCharged: 10, requests: 0 });
    expect(await findRollup('model', 'm1')).toMatchObject({ costUsd: 2, creditsCharged: 10 });
  });

  it('excludes rows outside the bucket', async () => {
    const bucketEnd = new Date(bucketStart.getTime() + SPEND_BUCKET_MS);
    await CreditTransaction.insertMany([
      deduct(CreditHolderType.User, 'user-a', -10, { createdAt: bucketStart }),
      deduct(CreditHolderType.User, 'user-a', -99, { createdAt: bucketEnd }),
      deduct(CreditHolderType.User, 'user-a', -77, { createdAt: new Date(bucketStart.getTime() - 1) }),
    ]);

    await spendRollupRepository.rollupBucket(bucketStart);

    expect(await findRollup('platform', 'all')).toMatchObject({ credits: 10 });
  });

  it('is idempotent', async () => {
    await CreditTransaction.insertMany([deduct(CreditHolderType.User, 'user-a', -100, { model: 'm1' })]);

    await spendRollupRepository.rollupBucket(bucketStart);
    const countAfterFirst = await SpendRollup.countDocuments({});
    await spendRollupRepository.rollupBucket(bucketStart);

    expect(await SpendRollup.countDocuments({})).toBe(countAfterFirst);
    expect(await findRollup('platform', 'all')).toMatchObject({ credits: 100 });
  });

  it('skips UsageEvent rows without a model instead of writing a null model scope', async () => {
    await UsageEvent.collection.insertOne({ ...usageEvent(1), model: null });

    await spendRollupRepository.rollupBucket(bucketStart);

    expect(await findRollup('platform', 'all')).toMatchObject({ costUsd: 1 });
    expect(await SpendRollup.countDocuments({ scopeType: 'model' })).toBe(0);
  });

  it('rejects a bucketStart that is not on a bucket boundary', async () => {
    await expect(spendRollupRepository.rollupBucket(inBucket)).rejects.toThrow(/bucket boundary/);
    expect(await SpendRollup.countDocuments({})).toBe(0);
  });

  it('writes a zero platform doc for an empty bucket', async () => {
    const result = await spendRollupRepository.rollupBucket(bucketStart);

    expect(result.docs).toBe(1);
    expect(await findRollup('platform', 'all')).toMatchObject({ credits: 0, costUsd: 0, requests: 0 });
    expect(await spendRollupRepository.latestBucketStart()).toEqual(bucketStart);
  });

  it('does not write the platform marker when a scope write fails', async () => {
    await CreditTransaction.insertMany([deduct(CreditHolderType.User, 'user-a', -100, { model: 'm1' })]);
    const bulkWrite = vi.spyOn(SpendRollup, 'bulkWrite').mockRejectedValueOnce(new Error('transient'));

    await expect(spendRollupRepository.rollupBucket(bucketStart)).rejects.toThrow('transient');
    bulkWrite.mockRestore();

    expect(await spendRollupRepository.latestBucketStart()).toBeNull();
    expect(await SpendRollup.countDocuments({})).toBe(0);
  });
});

describe('ledger usage scan', () => {
  it('is served by a CreditTransaction index rather than a collection scan', async () => {
    await CreditTransaction.syncIndexes();
    await CreditTransaction.insertMany([deduct(CreditHolderType.User, 'user-a', -1)]);

    const plan = await CreditTransaction.aggregate([
      { $match: ledgerUsageMatch(bucketStart, new Date(bucketStart.getTime() + SPEND_BUCKET_MS)) },
    ]).explain();

    const stages = JSON.stringify(plan);
    expect(stages).toContain('IXSCAN');
    expect(stages).not.toContain('COLLSCAN');
  });
});

describe('SpendRollupRepository reads', () => {
  const seed = async () => {
    const second = new Date(bucketStart.getTime() + SPEND_BUCKET_MS);
    const third = new Date(second.getTime() + SPEND_BUCKET_MS);
    await SpendRollup.insertMany([
      { bucketStart, scopeType: 'User', scopeId: 'a', credits: 10, requests: 1 },
      { bucketStart: second, scopeType: 'User', scopeId: 'a', credits: 20, requests: 2 },
      { bucketStart: third, scopeType: 'User', scopeId: 'a', credits: 40, requests: 4 },
      { bucketStart, scopeType: 'User', scopeId: 'b', credits: 5, requests: 1 },
    ]);
    return { second, third };
  };

  it('sumWindow sums buckets per scope and filters by scopeIds', async () => {
    const { third } = await seed();

    const all = await spendRollupRepository.sumWindow('User', bucketStart, third);
    expect(all.get('a')).toMatchObject({ credits: 30, requests: 3 });
    expect(all.get('b')).toMatchObject({ credits: 5 });

    const onlyB = await spendRollupRepository.sumWindow('User', bucketStart, third, ['b']);
    expect([...onlyB.keys()]).toEqual(['b']);
  });

  it('latestBucketStart reads the platform doc through the scope index without an in-memory sort', async () => {
    await seed();
    await SpendRollup.insertMany([{ bucketStart, scopeType: 'platform', scopeId: 'all' }]);
    const findOne = vi.spyOn(SpendRollup, 'findOne');

    await expect(spendRollupRepository.latestBucketStart()).resolves.toEqual(bucketStart);

    const [filter] = findOne.mock.calls[0];
    findOne.mockRestore();
    expect(filter).toEqual({ scopeType: 'platform', scopeId: 'all' });
    const plan = JSON.stringify(await SpendRollup.find(filter).sort({ bucketStart: -1 }).limit(1).explain());
    expect(plan).toContain('scopeType_1_scopeId_1_bucketStart_-1');
    expect(plan).not.toContain('"stage":"SORT"');
  });

  it('windowSeries returns per-bucket docs ascending', async () => {
    const { second, third } = await seed();

    const series = await spendRollupRepository.windowSeries('User', ['a'], bucketStart, new Date(third.getTime() + 1));

    expect(series.get('a')?.map(doc => doc.bucketStart)).toEqual([bucketStart, second, third]);
  });
});
