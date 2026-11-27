import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { KnowledgeType } from '@bike4mind/common';
import { FabFile, StorageDriftRecord, User, fabFileRepository, userRepository } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';

vi.mock('sst', () => ({ Resource: { App: { stage: 'test' } } }));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: { MONGODB_URI: 'unused' } }));
vi.mock('@bike4mind/server-utils/utils/cloudwatch', () => ({ emitMetrics: vi.fn() }));
const { postMessageToSlack } = vi.hoisted(() => ({ postMessageToSlack: vi.fn() }));
vi.mock('@bike4mind/server-utils/integrations/slack/slack', () => ({ postMessageToSlack }));

import { runStorageReconciliation, StorageReconciliationOptions } from './storageReconciliation';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
let mongo: Awaited<ReturnType<typeof createMongoServer>>;

const options = (overrides: Partial<StorageReconciliationOptions> = {}): StorageReconciliationOptions => ({
  repair: true,
  driftAlertBytes: 500,
  driftedUserCeiling: 50,
  ceilingMinDriftBytes: 1,
  ...overrides,
});

const AN_HOUR_AGO = () => new Date(Date.now() - 60 * 60 * 1000);

// Ages the recorded checks past MIN_STABLE_AGE_MS and clears the cursor, so the next pass treats
// unchanged drift as having held still and may repair it.
async function ageRecordsAndRestart() {
  await StorageDriftRecord.updateMany({}, { $set: { checkedAt: new Date(Date.now() - 2 * 60 * 60 * 1000) } });
  await mongoose.connection.collection('caches').deleteMany({});
}

async function recordStableDrift() {
  await runStorageReconciliation(options());
  await ageRecordsAndRestart();
}

async function seedUser(counter: number | undefined, fileSizes: number[]) {
  const user = await User.create({ username: `storage-${new mongoose.Types.ObjectId()}`, name: 'Storage fixture' });
  // The schema defaults the counter; unset it to cover a legacy row with no counter at all.
  await User.collection.updateOne(
    { _id: user._id },
    counter === undefined ? { $unset: { currentStorageSize: '' } } : { $set: { currentStorageSize: counter } }
  );
  const userId = String(user._id);
  for (const [i, fileSize] of fileSizes.entries()) {
    await FabFile.create({
      userId,
      fileName: `f${i}.txt`,
      filePath: `${userId}/f${i}.txt`,
      mimeType: 'text/plain',
      type: KnowledgeType.FILE,
      status: 'complete',
      storageChargedAt: new Date(),
      fileSize,
    });
  }
  return userId;
}

const counterOf = async (userId: string) =>
  (await User.collection.findOne({ _id: new mongoose.Types.ObjectId(userId) }))?.currentStorageSize;

beforeAll(async () => {
  mongo = await createMongoServer();
  await mongoose.connect(mongo.getUri());
});
beforeEach(async () => {
  await Promise.all([User.deleteMany({}), FabFile.deleteMany({}), StorageDriftRecord.deleteMany({})]);
  await mongoose.connection.collection('caches').deleteMany({});
  postMessageToSlack.mockClear();
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});

describe('storage reconciliation against a real database', () => {
  it('repairs drifted counters, including a missing one, and records every user', async () => {
    const over = await seedUser(1000, [400]);
    const missing = await seedUser(undefined, [300]);
    const exact = await seedUser(250, [100, 150]);

    const firstSighting = await runStorageReconciliation(options());
    expect(firstSighting).toMatchObject({ checked: 3, drifted: 2, repaired: 0 });
    expect(await counterOf(over)).toBe(1000);
    await ageRecordsAndRestart();

    const result = await runStorageReconciliation(options());

    expect(result).toMatchObject({ checked: 3, drifted: 2, repaired: 2, conflicts: 0, passCompleted: true });
    expect(await counterOf(over)).toBe(400);
    expect(await counterOf(missing)).toBe(300);
    expect(await counterOf(exact)).toBe(250);
    const records = await StorageDriftRecord.find({ checkedAt: { $gt: AN_HOUR_AGO() } }).lean();
    expect(records.map(r => [r.userId, r.drift]).sort()).toEqual(
      [
        [over, 600],
        [missing, -300],
        [exact, 0],
      ].sort()
    );
  });

  it('never overwrites a charge that commits between the counter read and the repair', async () => {
    const racer = await seedUser(1000, [400]);
    await recordStableDrift();
    const realSum = fabFileRepository.sumFileSizeByUserId.bind(fabFileRepository);
    vi.spyOn(fabFileRepository, 'sumFileSizeByUserId').mockImplementation(async userId => {
      const truth = await realSum(userId);
      // A concurrent upload's charge lands after the cron read the counter and computed truth.
      if (userId === racer) await userRepository.incrementCurrentStorage(racer, 50);
      return truth;
    });

    const result = await runStorageReconciliation(options());

    expect(result).toMatchObject({ repaired: 0, conflicts: 1 });
    expect(await counterOf(racer)).toBe(1050);
    const [record] = await StorageDriftRecord.find({ userId: racer }).sort({ checkedAt: -1 }).limit(1).lean();
    expect(record).toMatchObject({ counter: 1000, truth: 400, repaired: false, conflict: true });
  });

  it('reports drift and alerts in dry-run mode without touching counters', async () => {
    const over = await seedUser(5000, [400]);

    const result = await runStorageReconciliation(options({ repair: false }));

    expect(result).toMatchObject({ drifted: 1, repaired: 0 });
    expect(await counterOf(over)).toBe(5000);
    expect(postMessageToSlack).toHaveBeenCalledTimes(1);
    expect(postMessageToSlack.mock.calls[0][0]).toContain(over);
  });
});
