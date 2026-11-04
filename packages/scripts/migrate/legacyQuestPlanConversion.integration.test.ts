import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose, { Types } from 'mongoose';
import { FabFile, Session, User, fabFileRepository } from '@bike4mind/database';
import { FabFileSourceType } from '@bike4mind/common';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../database/src/__test__/createMongoServer';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
vi.mock('../utils/config', () => ({ Config: {} }));

import { convertLegacyQuestPlans, type ArchiveStorage } from './legacyQuestPlanConversion';

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

let objects: Map<string, string>;
let failOn: string | null;
const storage = (): ArchiveStorage => ({
  upload: async (path, content) => {
    if (failOn && String(content).includes(failOn)) throw new Error('boom');
    objects.set(path, String(content));
    return path;
  },
  generateSignedUrl: async path => `https://s3.test/${path}`,
  overwrite: async (path, content) => {
    objects.set(path, content);
  },
});

const logger = { info: () => {}, warn: () => {} };
const run = (batchSize?: number) =>
  convertLegacyQuestPlans({ storage: storage(), logger, now: new Date('2026-11-04'), batchSize });

const plans = () => mongoose.connection.db!.collection('questmasterplans');
const graphs = () => mongoose.connection.db!.collection('questgraphs');
const nodes = () => mongoose.connection.db!.collection('questnodes');

const T0 = new Date('2026-10-01T00:00:00Z');
const T1 = new Date('2026-10-02T00:00:00Z');

const insertUser = async (over: Record<string, unknown> = {}) => {
  const _id = new Types.ObjectId();
  await User.collection.insertOne({
    _id,
    username: `u${_id}`,
    email: `${_id}@test.local`,
    storageLimit: 1,
    currentStorageSize: 0,
    ...over,
  });
  return String(_id);
};

const insertPlan = async (over: Record<string, unknown> = {}) => {
  const _id = new Types.ObjectId();
  await plans().insertOne({
    _id,
    notebookId: String(new Types.ObjectId()),
    goal: 'Ship the thing',
    state: 'active',
    priority: 'medium',
    tags: [],
    quests: [
      {
        id: 'q1',
        title: 'Quest',
        complexity: 'low',
        subQuests: [{ id: 's1', title: 'Sub', status: 'completed', description: 'd' }],
      },
    ],
    deletedAt: null,
    createdAt: T0,
    updatedAt: T0,
    ...over,
  });
  return String(_id);
};

const insertGraph = async (userId: string, over: Record<string, unknown> = {}) => {
  const _id = new Types.ObjectId();
  const graphId = String(_id);
  const nodeId = new Types.ObjectId();
  await graphs().insertOne({
    _id,
    goal: 'Graph goal',
    userId,
    rootNodeIds: [String(nodeId)],
    state: 'draft',
    visibility: 'private',
    budget: {},
    deletedAt: null,
    createdAt: T0,
    updatedAt: T0,
    ...over,
  });
  const base = {
    graphId,
    parentId: null,
    dependsOn: [],
    order: 0,
    kind: 'task',
    status: 'pending',
    deletedAt: null,
    createdAt: T0,
    updatedAt: T0,
  };
  await nodes().insertMany([
    { _id: nodeId, ...base, title: 'Live node', task: 't' },
    { _id: new Types.ObjectId(), ...base, title: 'Deleted node', task: 't', deletedAt: T0 },
  ]);
  return graphId;
};

const archives = (userId?: string) =>
  FabFile.find({ sourceType: FabFileSourceType.QUESTMASTER_ARCHIVE, ...(userId ? { userId } : {}) }, null, {
    includeDeleted: true,
  }).lean();

beforeEach(async () => {
  await mongoose.connection.dropDatabase();
  objects = new Map();
  failOn = null;
});

describe('convertLegacyQuestPlans', () => {
  it('turns a v4 plan into an owner-only file with front-matter carrying the source id', async () => {
    const owner = await insertUser();
    const other = await insertUser();
    const id = await insertPlan({ userId: owner, sharedWith: [other] });

    const { plans: counts } = await run();

    const files = await archives();
    expect(counts.created).toBe(1);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      userId: owner,
      users: [],
      storageExempt: true,
      tags: [{ name: 'questmaster-archive', strength: 1 }],
      sourceMetadata: { sourceKind: 'quest-plan', sourceId: id },
    });
    const content = objects.get(files[0].filePath as string)!;
    expect(content.startsWith('---\n')).toBe(true);
    expect(content).toContain(id);
  });

  it('turns a v5 graph and its live nodes into one file', async () => {
    const owner = await insertUser();
    const id = await insertGraph(owner);

    const { graphs: counts } = await run();

    const [file] = await archives(owner);
    expect(counts.created).toBe(1);
    expect(file.sourceMetadata).toMatchObject({ sourceKind: 'quest-graph', sourceId: id });
    const content = objects.get(file.filePath as string)!;
    expect(content).toContain('Live node');
    expect(content).not.toContain('Deleted node');
  });

  it('is idempotent', async () => {
    const owner = await insertUser();
    await insertPlan({ userId: owner });
    await insertGraph(owner);
    await run();

    const second = await run();

    expect(second.plans).toMatchObject({ created: 0, unchanged: 1 });
    expect(second.graphs).toMatchObject({ created: 0, unchanged: 1 });
    expect(await archives()).toHaveLength(2);
  });

  it('refreshes a stale file in place under the same id', async () => {
    const owner = await insertUser();
    const id = await insertPlan({ userId: owner });
    await run();
    const [before] = await archives();

    await plans().updateOne({ _id: new Types.ObjectId(id) }, { $set: { goal: 'A brand new goal', updatedAt: T1 } });
    const { plans: counts } = await run();

    const [after] = await archives();
    expect(counts.refreshed).toBe(1);
    expect(String(after._id)).toBe(String(before._id));
    expect(await archives()).toHaveLength(1);
    const content = objects.get(after.filePath as string)!;
    expect(content).toContain('A brand new goal');
    expect(after.sourceMetadata?.sourceUpdatedAt).toBe(T1.toISOString());
    expect(after.fileSize).toBe(Buffer.byteLength(content));
  });

  it('leaves a file the user rewrote alone', async () => {
    const owner = await insertUser();
    const id = await insertPlan({ userId: owner });
    await run();
    const [file] = await archives();
    await FabFile.collection.updateOne({ _id: file._id }, { $set: { fileSize: 1 } });

    await plans().updateOne({ _id: new Types.ObjectId(id) }, { $set: { goal: 'Changed', updatedAt: T1 } });
    const { plans: counts } = await run();

    expect(counts).toMatchObject({ refreshed: 0, skippedUserEdited: 1 });
    expect(objects.get(file.filePath as string)).not.toContain('Changed');
  });

  it('resolves the owner through the notebook, and skips a plan with no owner', async () => {
    const owner = await insertUser();
    const session = new Types.ObjectId();
    await Session.collection.insertOne({ _id: session, userId: owner, name: 'nb' });
    await insertPlan({ notebookId: String(session) });
    await insertPlan();

    const { plans: counts } = await run();

    expect(counts).toMatchObject({ created: 1, skippedNoOwner: 1 });
    expect((await archives())[0].userId).toBe(owner);
  });

  it('skips empty and soft-deleted sources', async () => {
    const owner = await insertUser();
    await insertPlan({ userId: owner, quests: [] });
    await insertPlan({ userId: owner, quests: [{ id: 'q', title: 'q', subQuests: [] }] });
    await insertPlan({ userId: owner, deletedAt: T0 });
    const emptyGraph = new Types.ObjectId();
    await graphs().insertOne({ _id: emptyGraph, goal: 'g', userId: owner, rootNodeIds: [], deletedAt: null });
    await insertGraph(owner, { deletedAt: T0 });

    const { plans: p, graphs: g } = await run();

    expect(p).toMatchObject({ live: 2, skippedEmpty: 2, created: 0 });
    expect(g).toMatchObject({ skippedEmpty: 1, created: 0 });
    expect(await archives()).toHaveLength(0);
  });

  it('does not resurrect a file the user deleted', async () => {
    const owner = await insertUser();
    await insertPlan({ userId: owner });
    await run();
    await FabFile.collection.updateMany({}, { $set: { deletedAt: new Date() } });

    const { plans: counts } = await run();

    expect(counts).toMatchObject({ created: 0, skippedUserDeleted: 1 });
    expect(await archives()).toHaveLength(1);
  });

  it('gives an over-quota owner a file without charging them', async () => {
    const owner = await insertUser({ storageLimit: 1, currentStorageSize: 5_000_000 });
    await insertPlan({ userId: owner });

    const { plans: counts } = await run();

    expect(counts.created).toBe(1);
    expect((await User.collection.findOne({ _id: new Types.ObjectId(owner) }))?.currentStorageSize).toBe(5_000_000);
    expect(await fabFileRepository.sumFileSizeByUserId(owner)).toBe(0);
  });

  it('pages through every source', async () => {
    const owner = await insertUser();
    for (let i = 0; i < 5; i++) await insertPlan({ userId: owner, goal: `Plan ${i}` });

    const { plans: counts } = await run(2);

    expect(counts).toMatchObject({ live: 5, created: 5 });
  });

  it('never writes to the legacy collections', async () => {
    const owner = await insertUser();
    await insertPlan({ userId: owner });
    await insertGraph(owner);
    const snapshot = async () => [
      await plans().find().toArray(),
      await graphs().find().toArray(),
      await nodes().find().toArray(),
    ];
    const before = await snapshot();

    await run();

    expect(await snapshot()).toEqual(before);
  });

  it('isolates one failing item', async () => {
    const owner = await insertUser();
    await insertPlan({ userId: owner, goal: 'Poison pill' });
    await insertPlan({ userId: owner, goal: 'Fine' });
    failOn = 'Poison pill';

    const { plans: counts } = await run();

    expect(counts).toMatchObject({ created: 1, failed: 1 });
    expect(counts.failedSamples).toHaveLength(1);
  });
});
