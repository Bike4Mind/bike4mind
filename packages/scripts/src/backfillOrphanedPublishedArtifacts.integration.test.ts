import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { Annotation, PublishedArtifact, User } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../database/src/__test__/createMongoServer';

vi.mock('../utils/config', () => ({ Config: {} }));

import { backfillOrphanedPublishedArtifacts, ORPHAN_BACKFILL_DELETED_BY } from './backfillOrphanedPublishedArtifacts';

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
  await mongoose.connection.dropDatabase();
});

const silent = () => undefined;

const liveUser = async () => {
  const _id = new mongoose.Types.ObjectId();
  await User.collection.insertOne({ _id, email: `${_id}@example.com`, username: String(_id) });
  return String(_id);
};

let seq = 0;
const artifact = (ownerId: string) => {
  seq += 1;
  return PublishedArtifact.collection.insertOne({
    publicId: `pub-${seq}`,
    tier: 'user',
    scopeId: ownerId,
    slug: `slug-${seq}`,
    ownerId,
    visibility: 'public',
    source: { kind: 'bundle' },
    deletedAt: null,
  });
};

describe('backfillOrphanedPublishedArtifacts', () => {
  it('dry run counts orphaned artifacts without writing', async () => {
    const gone = String(new mongoose.Types.ObjectId());
    await artifact(gone);
    await artifact(gone);
    await artifact(await liveUser());

    const result = await backfillOrphanedPublishedArtifacts({ dryRun: true, log: silent });

    expect(result).toEqual({ orphanedOwners: 1, artifacts: 2 });
    expect(await PublishedArtifact.countDocuments({ deletedAt: null })).toBe(3);
  });

  it("execute soft-deletes only the deleted owners' artifacts and their children", async () => {
    const gone = String(new mongoose.Types.ObjectId());
    const live = await liveUser();
    await artifact(gone);
    await artifact(live);
    await Annotation.collection.insertOne({ publicId: `pub-${seq - 1}`, authorId: 'v', deletedAt: null });

    const result = await backfillOrphanedPublishedArtifacts({ dryRun: false, batchSize: 1, log: silent });

    expect(result).toEqual({ orphanedOwners: 1, artifacts: 1 });
    expect(await PublishedArtifact.countDocuments({ ownerId: gone, deletedBy: ORPHAN_BACKFILL_DELETED_BY })).toBe(1);
    expect(await PublishedArtifact.countDocuments({ ownerId: live, deletedAt: null })).toBe(1);
    expect(await Annotation.countDocuments({ deletedAt: null })).toBe(0);
  });

  it('treats an ownerId that cannot be a user id as orphaned', async () => {
    await artifact('not-an-object-id');

    const result = await backfillOrphanedPublishedArtifacts({ dryRun: false, log: silent });

    expect(result).toEqual({ orphanedOwners: 1, artifacts: 1 });
  });

  it('is a no-op on a re-run', async () => {
    await artifact(String(new mongoose.Types.ObjectId()));
    await backfillOrphanedPublishedArtifacts({ dryRun: false, log: silent });

    expect(await backfillOrphanedPublishedArtifacts({ dryRun: false, log: silent })).toEqual({
      orphanedOwners: 0,
      artifacts: 0,
    });
  });
});
