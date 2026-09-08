import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../__test__/createMongoServer';
import { Artifact } from './ArtifactModel';

/**
 * Real server, because the failure only appears on a row READ BACK from Mongo: `permissions` has
 * no default, so a stored artifact can lack it, and the `isPublic` virtual runs on every
 * toObject()/toJSON(). Unguarded, that turned one such row into a 500 for the whole notebook
 * export instead of a missing field on one artifact.
 */

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

describe('Artifact isPublic virtual', () => {
  it('serializes a row that has no permissions sub-document', async () => {
    // Written through the driver, bypassing Mongoose, which is how such rows exist today.
    await mongoose.connection.db!.collection('artifacts').insertOne({
      id: 'artifact_1_no_permissions',
      userId: 'owner-1',
      title: 'no permissions',
      visibility: 'private',
    });

    const doc = await Artifact.findOne({ id: 'artifact_1_no_permissions' });

    expect(() => doc!.toJSON()).not.toThrow();
    // Explicitly `false`, not undefined: undefined JSON-serializes as a MISSING key, so a consumer
    // doing `artifact.isPublic === false` would get a different answer than before the guard.
    expect((doc!.toJSON() as { isPublic?: boolean }).isPublic).toBe(false);
  });

  it('still reports a public artifact as public', async () => {
    await mongoose.connection.db!.collection('artifacts').insertOne({
      id: 'artifact_2_public',
      userId: 'owner-1',
      title: 'public one',
      visibility: 'public',
    });

    const doc = await Artifact.findOne({ id: 'artifact_2_public' });

    expect((doc!.toJSON() as { isPublic?: boolean }).isPublic).toBe(true);
  });

  it('reads isPublic off the permissions sub-document when it is present', async () => {
    await mongoose.connection.db!.collection('artifacts').insertOne({
      id: 'artifact_3_permissioned',
      userId: 'owner-1',
      title: 'permissioned',
      visibility: 'private',
      permissions: { canRead: [], canWrite: [], canDelete: [], isPublic: true, inheritFromProject: true },
    });

    const doc = await Artifact.findOne({ id: 'artifact_3_permissioned' });

    expect((doc!.toJSON() as { isPublic?: boolean }).isPublic).toBe(true);
  });
});
