import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import {
  DataLakeModel,
  DataLakeFindingModel,
  FabFile,
  FabFileChunk,
  dataLakeRepository,
  dataLakeFindingRepository,
} from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';

vi.mock('@server/utils/cloudwatch', () => {
  throw new Error('Local sweep must not load CloudWatch');
});
import { runLakeInconsistencySweep } from './lakeInconsistencySweep';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
let server: Awaited<ReturnType<typeof createMongoServer>>;
const firstAt = new Date('2026-09-30T04:00:00Z');
async function seedLake(slug: string, status = 'active') {
  const tag = `datalake:${slug}`;
  const lake = await DataLakeModel.create({
    name: slug,
    slug,
    datalakeTag: tag,
    fileTagPrefix: `${slug}:`,
    createdByUserId: 'local-owner',
    status,
  });
  const ids: string[] = [];
  for (const [index, text] of ['Uptime is 99.9%', 'Uptime is 99.5%'].entries()) {
    const id = new mongoose.Types.ObjectId();
    ids.push(String(id));
    await FabFile.collection.insertOne({
      _id: id,
      userId: 'local-owner',
      fileName: `reference-${index}.txt`,
      fileSize: 20,
      tags: [{ name: tag }],
      deletedAt: null,
      archivedAt: null,
    });
    await FabFileChunk.collection.insertOne({ fabFileId: String(id), text });
  }
  return { id: String(lake._id), ids };
}
beforeAll(async () => {
  server = await createMongoServer({ instance: { launchTimeout: MONGO_TEST_TIMEOUT_MS } });
  await mongoose.connect(server.getUri());
  await DataLakeFindingModel.init();
});
afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});
beforeEach(async () => {
  for (const collection of Object.values(mongoose.connection.collections)) await collection.deleteMany({});
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(firstAt);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('local lexical sweep persisted effects', () => {
  it('detects actual text disagreement, excludes inactive lakes and reuses finding identity', async () => {
    const lake = await seedLake('active');
    await seedLake('draft', 'draft');
    expect(await runLakeInconsistencySweep()).toMatchObject({ scanned: 1, failed: 0, findingsRecorded: 1 });
    const findings = await dataLakeFindingRepository.listByLake(lake.id);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      detector: 'lexical',
      kind: 'metric-disagreement',
      status: 'open',
      documentCount: 2,
    });
    expect(findings[0].sources.map(source => source.fabFileId).sort()).toEqual([...lake.ids].sort());
    expect(findings[0].sources.map(source => source.excerpt).sort()).toEqual(['Uptime is 99.5%', 'Uptime is 99.9%']);
    const stored = await dataLakeRepository.findById(lake.id);
    expect(stored?.inconsistencyComputedAt).toEqual(firstAt);
    expect(stored?.lastInconsistencyScanAt).toEqual(firstAt);
    vi.setSystemTime(new Date('2026-10-01T04:00:00Z'));
    await runLakeInconsistencySweep();
    const repeated = await dataLakeFindingRepository.listByLake(lake.id);
    expect(repeated).toHaveLength(1);
    expect(repeated[0].id).toBe(findings[0].id);
  });

  it('preserves a dismissed finding while excluding it from the stored summary', async () => {
    const lake = await seedLake('dismissed');
    await runLakeInconsistencySweep();
    const [finding] = await dataLakeFindingRepository.listByLake(lake.id);
    await DataLakeFindingModel.updateOne({ _id: finding.id }, { $set: { status: 'dismissed' } });
    const nextAt = new Date('2026-10-01T04:00:00Z');
    vi.setSystemTime(nextAt);
    await runLakeInconsistencySweep();
    const rows = await DataLakeFindingModel.find({ lakeId: lake.id }).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('dismissed');
    expect(rows[0].lastSeenAt).toEqual(nextAt);
    const lakeAfter = await dataLakeRepository.findById(lake.id);
    expect(lakeAfter?.inconsistencyReport?.countsByKind['metric-disagreement']).toBe(0);
    expect(lakeAfter?.inconsistencyComputedAt).toEqual(nextAt);
  });

  it('withholds a fresh summary after finding-write failure and recovers on the next daily pass', async () => {
    const lake = await seedLake('retry');
    await runLakeInconsistencySweep();
    const failedAt = new Date('2026-10-01T04:00:00Z');
    vi.setSystemTime(failedAt);
    const write = vi
      .spyOn(dataLakeFindingRepository, 'recordDetected')
      .mockRejectedValueOnce(new Error('write unavailable'));
    expect(await runLakeInconsistencySweep()).toMatchObject({ scanned: 1, failed: 1, findingsFailed: 1 });
    let stored = await dataLakeRepository.findById(lake.id);
    expect(stored?.inconsistencyComputedAt).toEqual(firstAt);
    expect(stored?.lastInconsistencyScanAt).toEqual(failedAt);
    write.mockRestore();
    const recoveredAt = new Date('2026-10-02T04:00:00Z');
    vi.setSystemTime(recoveredAt);
    expect(await runLakeInconsistencySweep()).toMatchObject({ failed: 0, findingsRecorded: 1 });
    stored = await dataLakeRepository.findById(lake.id);
    expect(stored?.inconsistencyComputedAt).toEqual(recoveredAt);
    expect(await dataLakeFindingRepository.listByLake(lake.id)).toHaveLength(1);
  });

  it('isolates summary-write failure and stamps both attempted lakes for fairness', async () => {
    const broken = await seedLake('broken');
    const healthy = await seedLake('healthy');
    const actual = dataLakeRepository.update.bind(dataLakeRepository);
    vi.spyOn(dataLakeRepository, 'update').mockImplementation(input => {
      if (input.id === broken.id) throw new Error('summary unavailable');
      return actual(input);
    });
    expect(await runLakeInconsistencySweep()).toMatchObject({ scanned: 2, failed: 1 });
    const failedLake = await dataLakeRepository.findById(broken.id);
    const goodLake = await dataLakeRepository.findById(healthy.id);
    expect(failedLake?.inconsistencyComputedAt ?? null).toBeNull();
    expect(failedLake?.lastInconsistencyScanAt).toEqual(firstAt);
    expect(goodLake?.inconsistencyComputedAt).toEqual(firstAt);
    expect(goodLake?.lastInconsistencyScanAt).toEqual(firstAt);
    expect(await dataLakeFindingRepository.listByLake(broken.id)).toHaveLength(1);
    expect(await dataLakeFindingRepository.listByLake(healthy.id)).toHaveLength(1);
  });
});
