import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { KnowledgeType, FabFileSourceType } from '@bike4mind/common';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../__test__/createMongoServer';
import { FabFile, fabFileRepository } from './FabFileModel';

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
}, MONGO_TEST_TIMEOUT_MS);
afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
}, MONGO_TEST_TIMEOUT_MS);
beforeEach(async () => {
  await FabFile.deleteMany({}, { hardDelete: true });
});

const TAG = 'datalake:gh-lake';
const row = (over: Record<string, unknown> = {}) => ({
  userId: 'u-gh',
  fileName: 'README.md',
  mimeType: 'text/markdown',
  type: KnowledgeType.FILE,
  filePath: `k-${Math.random().toString(36).slice(2)}.md`,
  status: 'complete',
  tags: [{ name: TAG, strength: 1 }],
  sourceType: FabFileSourceType.GITHUB,
  githubConnectionId: 'gh-conn-1',
  githubPath: 'README.md',
  githubBlobSha: 'blob-sha-1',
  sourceLakeId: 'lake-1',
  ...over,
});

describe('FabFile GitHub provenance', () => {
  it('round-trips githubConnectionId, githubPath, githubBlobSha and the GITHUB source type', async () => {
    const created = await FabFile.create(row());
    const reloaded = await FabFile.findById(created.id);
    expect(reloaded?.sourceType).toBe(FabFileSourceType.GITHUB);
    expect(reloaded?.githubConnectionId).toBe('gh-conn-1');
    expect(reloaded?.githubPath).toBe('README.md');
    expect(reloaded?.githubBlobSha).toBe('blob-sha-1');
    expect(reloaded?.sourceLakeId).toBe('lake-1');
  });

  it('findByGitHubConnectionIdInDataLake returns only the connection s live, uploaded lake members', async () => {
    const live = await FabFile.create(row());
    await FabFile.create(row({ status: 'pending', githubPath: 'pending.md' }));
    await FabFile.create(row({ githubConnectionId: 'other-conn', githubPath: 'other.md' }));
    await FabFile.create(row({ tags: [{ name: 'datalake:other', strength: 1 }], githubPath: 'untagged.md' }));
    await FabFile.create(row({ deletedAt: new Date(), githubPath: 'deleted.md' }));
    await FabFile.create(row({ archivedAt: new Date(), githubPath: 'archived.md' }));

    const found = await fabFileRepository.findByGitHubConnectionIdInDataLake('gh-conn-1', TAG);
    expect(found.map(f => f.id)).toEqual([live.id]);
  });

  it('findByGitHubConnectionIdInDataLake({ includeDeleted: true }) also reaches archived and soft-deleted rows, but not pending ones', async () => {
    const live = await FabFile.create(row());
    const deleted = await FabFile.create(row({ deletedAt: new Date(), githubPath: 'deleted.md' }));
    const archived = await FabFile.create(row({ archivedAt: new Date(), githubPath: 'archived.md' }));
    await FabFile.create(row({ status: 'pending', githubPath: 'pending.md' }));
    await FabFile.create(row({ githubConnectionId: 'other-conn', githubPath: 'other.md' }));
    await FabFile.create(row({ tags: [{ name: 'datalake:other', strength: 1 }], githubPath: 'untagged.md' }));

    const found = await fabFileRepository.findByGitHubConnectionIdInDataLake('gh-conn-1', TAG, { includeDeleted: true });
    expect(found.map(f => f.id).sort()).toEqual([live.id, deleted.id, archived.id].sort());
  });

  it('declares the { githubConnectionId, deletedAt, status } reconcile index', async () => {
    await FabFile.createIndexes();
    const indexes = await FabFile.collection.indexes();
    expect(indexes.find(i => i.name === 'githubConnectionId_1_deletedAt_1_status_1')?.key).toEqual({
      githubConnectionId: 1,
      deletedAt: 1,
      status: 1,
    });
  });
});
