import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../__test__/createMongoServer';
import { Artifact, artifactRepository } from './ArtifactModel';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let server: Awaited<ReturnType<typeof createMongoServer>>;

const seed = (id: string, extra: Record<string, unknown> = {}) =>
  Artifact.create({
    id,
    type: 'react',
    title: id,
    version: 1,
    userId: 'u1',
    sessionId: 's1',
    permissions: { canRead: [], canWrite: [], canDelete: [] },
    contentId: new mongoose.Types.ObjectId(),
    contentHash: 'h',
    contentSize: 1,
    ...extra,
  });

// Same shape as the identifier filter in b4m-core/services/src/artifactService/list.ts.
const byIdentifier = (identifier: string) => ({
  sessionId: 's1',
  $or: [{ identifier }, { identifier: { $exists: false }, 'metadata.originalIdentifier': identifier }],
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

describe('Artifact identifier', () => {
  it('is stored and read back, not stripped by strict mode', async () => {
    await seed('a', { identifier: 'todo_app' });

    const [row] = await artifactRepository.find({ id: 'a' });

    expect(row.identifier).toBe('todo_app');
  });

  it('declares the session identifier index', () => {
    expect(Artifact.schema.indexes().map(([fields]) => fields)).toContainEqual({ sessionId: 1, identifier: 1 });
  });

  it('matches by field, falls back to metadata only for rows without the field', async () => {
    await seed('current', { identifier: 'todo' });
    await seed('legacy', { metadata: { originalIdentifier: 'todo' } });
    await seed('other', { identifier: 'chart', metadata: { originalIdentifier: 'todo' } });
    await seed('legacy-other', { metadata: { originalIdentifier: 'chart' } });

    const rows = await artifactRepository.find(byIdentifier('todo'));

    expect(rows.map(r => r.id).sort()).toEqual(['current', 'legacy']);
  });
});
