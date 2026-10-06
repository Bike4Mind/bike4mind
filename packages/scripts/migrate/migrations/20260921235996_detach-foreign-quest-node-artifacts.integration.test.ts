import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { Artifact, QuestGraph, QuestNode } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../database/src/__test__/createMongoServer';

vi.mock('../../utils/config', () => ({ Config: {} }));

import migration from './20260921235996_detach-foreign-quest-node-artifacts';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

beforeEach(async () => {
  await Promise.all([Artifact.deleteMany({}), QuestGraph.deleteMany({}), QuestNode.deleteMany({})]);
});

const artifact = (id: string, userId: string) =>
  Artifact.create({
    id,
    type: 'code',
    title: id,
    userId,
    version: 1,
    contentId: new mongoose.Types.ObjectId(),
    contentHash: 'fixture',
    contentSize: 1,
    permissions: { canRead: [], canWrite: [], canDelete: [], isPublic: false, inheritFromProject: true },
  });

const graphOwnedBy = async (userId: string) => String((await QuestGraph.create({ goal: 'g', userId }))._id);

const node = async (graphId: string, artifactIds: string[], extra: Record<string, unknown> = {}) =>
  String((await QuestNode.create({ graphId, title: 'n', task: 't', artifactIds, ...extra }))._id);

const artifactIdsOf = async (nodeId: string) =>
  ((await QuestNode.collection.findOne({ _id: new mongoose.Types.ObjectId(nodeId) }))?.artifactIds ?? []) as string[];

describe('detach-foreign-quest-node-artifacts', () => {
  it("pulls another user's artifact off the node and keeps the owner's", async () => {
    await artifact('own', 'owner');
    await artifact('planted', 'attacker');
    const nodeId = await node(await graphOwnedBy('owner'), ['own', 'planted']);

    await migration.up();

    expect(await artifactIdsOf(nodeId)).toEqual(['own']);
  });

  it('also cleans a soft-deleted node, so a restore does not bring the planted ref back', async () => {
    await artifact('planted', 'attacker');
    const nodeId = await node(await graphOwnedBy('owner'), ['planted'], { deletedAt: new Date() });

    await migration.up();

    expect(await artifactIdsOf(nodeId)).toEqual([]);
  });

  it('leaves ids alone when ownership cannot be established', async () => {
    const orphanNode = await node(new mongoose.Types.ObjectId().toString(), ['x']);
    await artifact('x', 'someone');
    const missingArtifact = await node(await graphOwnedBy('owner'), ['gone']);

    await migration.up();

    expect(await artifactIdsOf(orphanNode)).toEqual(['x']);
    expect(await artifactIdsOf(missingArtifact)).toEqual(['gone']);
  });

  it('is idempotent', async () => {
    await artifact('own', 'owner');
    await artifact('planted', 'attacker');
    const nodeId = await node(await graphOwnedBy('owner'), ['own', 'planted']);

    await migration.up();
    await migration.up();

    expect(await artifactIdsOf(nodeId)).toEqual(['own']);
  });
});
