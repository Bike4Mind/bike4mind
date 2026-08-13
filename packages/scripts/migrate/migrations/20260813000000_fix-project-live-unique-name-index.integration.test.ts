import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { Project, safeDropIndex } from '@bike4mind/database';
import { createMongoServer } from '../../../database/src/__test__/createMongoServer';

// A core migration imported transitively via '@bike4mind/database' need not evaluate SST config,
// but mirror the sibling drop-legacy-fabfilechunk test's guard so this stays robust if that changes.
vi.mock('../../utils/config', () => ({ Config: {} }));

import migration from './20260813000000_fix-project-live-unique-name-index';

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
  await Project.collection.deleteMany({});
  // Ensure no unique index exists before seeding duplicates (autoIndex may have built it on connect).
  await safeDropIndex(Project.collection, 'userId_1_name_1');
});

// Real mongod, not mocks: the migration relies on server behavior (raw-collection filter bypassing
// the softDelete hooks, safeDropIndex swallow-on-missing, unique-index enforcement on rebuild).
describe('fix-project-live-unique-name-index migration (real DB)', () => {
  it('dedupes live duplicates, keeps the most-recent, and rebuilds an enforcing unique index', async () => {
    await Project.collection.insertMany([
      { userId: 'u1', name: 'Roadmap', deletedAt: null, updatedAt: new Date('2026-01-01T00:00:00Z') },
      { userId: 'u1', name: 'Roadmap', deletedAt: null, updatedAt: new Date('2026-03-01T00:00:00Z') },
      { userId: 'u1', name: 'Backlog', deletedAt: null },
      { userId: 'u2', name: 'Roadmap', deletedAt: null },
      // Already soft-deleted duplicate: outside the live filter, must be left untouched.
      { userId: 'u1', name: 'Roadmap', deletedAt: new Date('2025-01-01T00:00:00Z') },
    ]);

    await migration.up();

    // Only the most-recently-updated live 'Roadmap' for u1 survives as live.
    const liveRoadmapU1 = await Project.collection.find({ userId: 'u1', name: 'Roadmap', deletedAt: null }).toArray();
    expect(liveRoadmapU1).toHaveLength(1);
    expect(liveRoadmapU1[0].updatedAt).toEqual(new Date('2026-03-01T00:00:00Z'));

    // The index is rebuilt as unique + partial and now actually enforces.
    const idx = (await Project.collection.indexes()).find(i => i.name === 'userId_1_name_1');
    expect(idx?.unique).toBe(true);
    expect(idx?.partialFilterExpression).toEqual({ deletedAt: null });

    await expect(Project.collection.insertOne({ userId: 'u1', name: 'Roadmap', deletedAt: null })).rejects.toMatchObject(
      { code: 11000 }
    );
    await expect(
      Project.collection.insertOne({ userId: 'u3', name: 'Roadmap', deletedAt: null })
    ).resolves.toBeDefined();
    await expect(
      Project.collection.insertOne({ userId: 'u1', name: 'Roadmap', deletedAt: new Date() })
    ).resolves.toBeDefined();
  }, 30000);

  it('is a no-op-safe rebuild when there are no duplicates, and is idempotent on re-run', async () => {
    await Project.collection.insertMany([
      { userId: 'u1', name: 'Solo', deletedAt: null },
      { userId: 'u2', name: 'Solo', deletedAt: null },
    ]);

    await migration.up();
    await migration.up(); // second run: safeDropIndex tolerates the existing index, no dupes to soft-delete

    expect(await Project.collection.countDocuments({ deletedAt: null })).toBe(2);
    const idx = (await Project.collection.indexes()).find(i => i.name === 'userId_1_name_1');
    expect(idx?.unique).toBe(true);
  }, 30000);
});
