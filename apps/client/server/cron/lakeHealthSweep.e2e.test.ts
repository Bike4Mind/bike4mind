import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import { DataLakeModel } from '../../../../packages/database/src/models/ai/DataLakeModel';
import {
  DataLakeHealthSnapshotModel,
  dataLakeHealthSnapshotRepository,
} from '../../../../packages/database/src/models/ai/DataLakeHealthSnapshotModel';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

vi.mock('@bike4mind/database', async () => {
  const lakes = await import('../../../../packages/database/src/models/ai/DataLakeModel');
  const snapshots = await import('../../../../packages/database/src/models/ai/DataLakeHealthSnapshotModel');
  return {
    connectDB: vi.fn(),
    dataLakeRepository: lakes.dataLakeRepository,
    dataLakeHealthSnapshotRepository: snapshots.dataLakeHealthSnapshotRepository,
    fabFileRepository: {},
    adminSettingsRepository: {},
    scopedSettingsRepository: {},
    memoryLedgerRepository: {},
  };
});
vi.mock('@server/utils/config', () => ({ Config: { MONGODB_URI: 'unused' } }));
vi.mock('sst', () => ({ Resource: { App: { stage: 'selfhost' } } }));
const { metric, compute } = vi.hoisted(() => ({ metric: vi.fn(), compute: vi.fn() }));
vi.mock('@server/utils/cloudwatch', () => ({ emitMetric: metric }));
vi.mock('@bike4mind/services', () => ({ dataLakeService: { computeLakeHealth: compute } }));
import { runLakeHealthSweep } from './lakeHealthSweep';
let mongo: Awaited<ReturnType<typeof createMongoServer>>;
beforeAll(async () => {
  mongo = await createMongoServer();
  await mongoose.connect(mongo.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});
beforeEach(async () => {
  vi.restoreAllMocks();
  metric.mockClear();
  compute.mockReset();
  await mongoose.connection.dropDatabase();
  await DataLakeHealthSnapshotModel.syncIndexes();
  compute.mockResolvedValue({
    serving: { status: 'active', servesRetrieval: true },
    reachableShare: 0.75,
    coverage: { measuredMembers: 4, membersWithChunks: 3 },
    predicates: {
      chunkWithinPolicy: { pass: 3, fail: 1, unknown: 0 },
      chunkCountConsistent: { pass: 3, fail: 1, unknown: 0 },
      fullyVectorized: { pass: 3, fail: 1, unknown: 0 },
      serveCapMeetsPolicy: 'pass',
    },
    affectedMemberCount: 1,
    scanTruncated: false,
    duplicateMembers: { memberCount: 0, groupCount: 0 },
    lakeMemory: { state: 'current' },
    inconsistency: null,
  });
});
async function seed(slug: string, status = 'active') {
  return DataLakeModel.create({
    name: slug,
    slug,
    fileTagPrefix: slug + ':',
    datalakeTag: 'datalake:' + slug,
    createdByUserId: 'local-test',
    status,
  });
}
it('persists only active-lake trends, upserts a repeat day and reads a distinct next-day row', async () => {
  const active = await seed('active');
  await seed('draft', 'draft');
  await seed('archived', 'archived');
  const RealDate = Date;
  let now = '2026-09-28T06:00:00Z';
  vi.spyOn(globalThis, 'Date').mockImplementation(function (value?: string | number | Date) {
    return value === undefined ? new RealDate(now) : new RealDate(value);
  } as DateConstructor);
  try {
    await runLakeHealthSweep({ emitMetrics: false });
    now = '2026-09-28T07:00:00Z';
    const repeated = await runLakeHealthSweep({ emitMetrics: false });
    expect(repeated).toMatchObject({ scanned: 1, failed: 0 });
    const [sameDay] = await dataLakeHealthSnapshotRepository.getTrend(active.id);
    expect(sameDay.computedAt.toISOString()).toBe(new RealDate(now).toISOString());
    expect(await DataLakeHealthSnapshotModel.countDocuments()).toBe(1);
    now = '2026-09-29T06:00:00Z';
    await runLakeHealthSweep({ emitMetrics: false });
    const trend = await dataLakeHealthSnapshotRepository.getTrend(active.id);
    expect(trend.map(row => row.snapshotDate)).toEqual(['2026-09-29', '2026-09-28']);
    expect(trend[0]).toMatchObject({ reachableShare: 0.75, inconsistencyFindingCount: null });
    expect(await DataLakeHealthSnapshotModel.countDocuments()).toBe(2);
    expect(metric).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
  }
});
it('isolates failed computation, stamps its attempt and preserves the next lake snapshot', async () => {
  const failed = await seed('failed');
  const good = await seed('good');
  compute.mockImplementation(async lake => {
    if (lake.id === failed.id) throw new Error('one lake failed');
    return {
      serving: { status: 'active', servesRetrieval: true },
      reachableShare: 0,
      coverage: { measuredMembers: 0, membersWithChunks: 0 },
      predicates: {
        chunkWithinPolicy: { pass: 0, fail: 0, unknown: 0 },
        chunkCountConsistent: { pass: 0, fail: 0, unknown: 0 },
        fullyVectorized: { pass: 0, fail: 0, unknown: 0 },
        serveCapMeetsPolicy: 'pass',
      },
      affectedMemberCount: 0,
      scanTruncated: false,
      duplicateMembers: { memberCount: 0, groupCount: 0 },
      lakeMemory: { state: 'current' },
      inconsistency: null,
    };
  });
  const result = await runLakeHealthSweep({ emitMetrics: false });
  expect(result).toMatchObject({ scanned: 2, failed: 1 });
  expect(await dataLakeHealthSnapshotRepository.getTrend(failed.id)).toEqual([]);
  expect(await dataLakeHealthSnapshotRepository.getTrend(good.id)).toHaveLength(1);
  expect((await DataLakeModel.findById(failed.id))?.lastHealthCheckedAt).toBeInstanceOf(Date);
});
