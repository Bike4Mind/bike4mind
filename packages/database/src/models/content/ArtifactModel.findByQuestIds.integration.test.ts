import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../__test__/createMongoServer';
import { Artifact, artifactRepository } from './ArtifactModel';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let server: Awaited<ReturnType<typeof createMongoServer>>;

const seed = (id: string, userId: string, sourceQuestId: string, extra: Record<string, unknown> = {}) =>
  Artifact.create({
    id,
    type: 'html',
    title: id,
    version: 1,
    userId,
    sourceQuestId,
    permissions: { canRead: [], canWrite: [], canDelete: [] },
    contentId: new mongoose.Types.ObjectId(),
    contentHash: 'h',
    contentSize: 1,
    ...extra,
  });

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

afterEach(async () => {
  await Artifact.collection.deleteMany({});
});

describe('ArtifactRepository.findByQuestIds', () => {
  it("returns only the given user's artifacts for a shared quest id", async () => {
    await seed('a', 'u1', 'q');
    await seed('b', 'u2', 'q');

    const rows = await artifactRepository.findByQuestIds(['q'], 'u1');

    expect(rows.map(r => r.id)).toEqual(['a']);
  });

  it('excludes soft-deleted rows', async () => {
    await seed('a', 'u1', 'q', { deletedAt: new Date() });

    expect(await artifactRepository.findByQuestIds(['q'], 'u1')).toEqual([]);
  });

  it('fails closed when userId is missing', async () => {
    await seed('a', 'u1', 'q');

    await expect(artifactRepository.findByQuestIds(['q'], '')).rejects.toThrow(/requires a userId/);
  });
});
