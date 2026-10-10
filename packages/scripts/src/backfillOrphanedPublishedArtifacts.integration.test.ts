import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { Annotation, DELETED_AUTHOR_ANNOTATION_MARKER, PublishedArtifact, User } from '@bike4mind/database';
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

const ORG_ID = new mongoose.Types.ObjectId();

const liveUser = async (organizationId: mongoose.Types.ObjectId | null = ORG_ID) => {
  const _id = new mongoose.Types.ObjectId();
  await User.collection.insertOne({ _id, email: `${_id}@example.com`, username: String(_id), organizationId });
  return String(_id);
};

let seq = 0;
const artifact = (ownerId: string, over: Record<string, unknown> = {}) => {
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
    ...over,
  });
};

describe('backfillOrphanedPublishedArtifacts', () => {
  it('dry run counts orphaned artifacts without writing', async () => {
    const gone = String(new mongoose.Types.ObjectId());
    await artifact(gone);
    await artifact(gone);
    await artifact(await liveUser());

    const result = await backfillOrphanedPublishedArtifacts({ dryRun: true, log: silent });

    expect(result).toEqual({ orphanedOwners: 1, artifacts: 2, transferred: 0, deletedAuthors: 0, annotations: 0 });
    expect(await PublishedArtifact.countDocuments({ deletedAt: null })).toBe(3);
  });

  it("execute soft-deletes only the deleted owners' artifacts and their children", async () => {
    const gone = String(new mongoose.Types.ObjectId());
    const live = await liveUser();
    await artifact(gone);
    await artifact(live);
    await Annotation.collection.insertOne({ publicId: `pub-${seq - 1}`, authorId: 'v', deletedAt: null });

    const result = await backfillOrphanedPublishedArtifacts({ dryRun: false, batchSize: 1, log: silent });

    expect(result).toEqual({ orphanedOwners: 1, artifacts: 1, transferred: 0, deletedAuthors: 0, annotations: 0 });
    expect(await PublishedArtifact.countDocuments({ ownerId: gone, deletedBy: ORPHAN_BACKFILL_DELETED_BY })).toBe(1);
    expect(await PublishedArtifact.countDocuments({ ownerId: live, deletedAt: null })).toBe(1);
    expect(await Annotation.countDocuments({ deletedAt: null })).toBe(0);
  });

  it('treats an ownerId that cannot be a user id as orphaned', async () => {
    await artifact('not-an-object-id');

    const result = await backfillOrphanedPublishedArtifacts({ dryRun: false, log: silent });

    expect(result).toEqual({ orphanedOwners: 1, artifacts: 1, transferred: 0, deletedAuthors: 0, annotations: 0 });
  });

  it('is a no-op on a re-run', async () => {
    await artifact(String(new mongoose.Types.ObjectId()));
    await backfillOrphanedPublishedArtifacts({ dryRun: false, log: silent });

    expect(await backfillOrphanedPublishedArtifacts({ dryRun: false, log: silent })).toEqual({
      orphanedOwners: 0,
      artifacts: 0,
      transferred: 0,
      deletedAuthors: 0,
      annotations: 0,
    });
  });

  it('hands org pages to a still-existing last publisher, reported separately in a dry run', async () => {
    const gone = String(new mongoose.Types.ObjectId());
    const teammate = await liveUser();
    await artifact(gone, { tier: 'organization', scopeId: String(ORG_ID), lastPublishedBy: teammate });
    const orgPublicId = `pub-${seq}`;
    await artifact(gone, { tier: 'organization', scopeId: String(ORG_ID) });
    await artifact(gone, { lastPublishedBy: teammate });

    const dry = await backfillOrphanedPublishedArtifacts({ dryRun: true, log: silent });
    expect(dry).toEqual({ orphanedOwners: 1, artifacts: 2, transferred: 1, deletedAuthors: 0, annotations: 0 });
    expect(await PublishedArtifact.countDocuments({ ownerId: gone, deletedAt: null })).toBe(3);

    const applied = await backfillOrphanedPublishedArtifacts({ dryRun: false, log: silent });
    expect(applied).toEqual({ orphanedOwners: 1, artifacts: 2, transferred: 1, deletedAuthors: 0, annotations: 0 });
    expect(await PublishedArtifact.findOne({ publicId: orgPublicId }).lean()).toMatchObject({
      ownerId: teammate,
      deletedAt: null,
    });
    expect(await PublishedArtifact.countDocuments({ ownerId: gone, deletedAt: null })).toBe(0);
  });

  it("moves a deleted author's annotations on live pages to the dustbin, dry run first", async () => {
    const owner = await liveUser();
    const viewer = await liveUser();
    const goneAuthor = String(new mongoose.Types.ObjectId());
    await artifact(owner);
    const publicId = `pub-${seq}`;
    await Annotation.collection.insertMany([
      { publicId, authorId: goneAuthor, deletedAt: null },
      { publicId, authorId: goneAuthor, deletedAt: null },
      { publicId, authorId: viewer, deletedAt: null },
    ]);

    const dry = await backfillOrphanedPublishedArtifacts({ dryRun: true, log: silent });
    expect(dry).toMatchObject({ orphanedOwners: 0, deletedAuthors: 1, annotations: 2 });
    expect(await Annotation.countDocuments({ deletedAt: null })).toBe(3);

    const applied = await backfillOrphanedPublishedArtifacts({ dryRun: false, log: silent });
    expect(applied).toMatchObject({ deletedAuthors: 1, annotations: 2 });
    expect(await Annotation.countDocuments({ authorId: goneAuthor, deletedBy: DELETED_AUTHOR_ANNOTATION_MARKER })).toBe(
      2
    );
    expect(await Annotation.countDocuments({ authorId: viewer, deletedAt: null })).toBe(1);
    expect(await backfillOrphanedPublishedArtifacts({ dryRun: false, log: silent })).toMatchObject({
      deletedAuthors: 0,
      annotations: 0,
    });
  });
});
