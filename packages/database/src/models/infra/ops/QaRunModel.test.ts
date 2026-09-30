import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoServer } from '../../../__test__/createMongoServer';
import { QaRun } from './QaRunModel';

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await createMongoServer();
  await mongoose.connect(mongod.getUri());
  await QaRun.syncIndexes();
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});
afterEach(async () => {
  await QaRun.deleteMany({});
});

const baseRun = {
  product: 'product-a',
  suite: 'Core',
  env: 'staging',
  branch: 'main',
  trigger: 'Run via Deployer',
  source: 'ci' as const,
  ciRunUrl: 'https://github.com/example/repo/actions/runs/1',
  sha: 'abc123',
  startedAt: new Date('2026-09-28T09:00:00.000Z'),
  durationMs: 1000,
  status: 'passed' as const,
  counts: { passed: 1, failed: 0, skipped: 0, notStarted: 0, ran: 1, total: 1 },
  externalRunId: '1-1',
};

describe('QaRunModel', () => {
  it('stores metrics and suite summary without subdocument ids', async () => {
    const doc = await QaRun.create({
      ...baseRun,
      tenant: 'tenant-a',
      suiteSummary: [{ name: 'Notebook', passed: 1, ran: 1, notRun: 0 }],
      metrics: [{ kind: 'latency', model: 'model-x', label: 'short-answers', value: 3.1, unit: 's', threshold: 5 }],
    });
    const found = await QaRun.findById(doc._id).lean();
    expect(found?.metrics[0]).toEqual({
      kind: 'latency',
      model: 'model-x',
      label: 'short-answers',
      value: 3.1,
      unit: 's',
      threshold: 5,
    });
    expect(found?.suiteSummary[0]).toEqual({ name: 'Notebook', passed: 1, ran: 1, notRun: 0 });
  });

  it('rejects a duplicate externalRunId', async () => {
    await QaRun.create(baseRun);
    await expect(QaRun.create({ ...baseRun })).rejects.toThrow(/duplicate key/);
  });

  it('rejects an unknown status', async () => {
    await expect(QaRun.create({ ...baseRun, status: 'weird' as unknown as 'passed' })).rejects.toThrow();
  });

  it('declares the query indexes', async () => {
    const keys = (await QaRun.collection.indexes()).map(i => i.key);
    expect(keys).toContainEqual({ product: 1, tenant: 1, suite: 1, env: 1, branch: 1, startedAt: -1 });
    expect(keys).toContainEqual({ product: 1, startedAt: -1 });
    expect(keys).toContainEqual({ externalRunId: 1 });
  });
});
