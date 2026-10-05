import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../__test__/createMongoServer';
import { Artifact, artifactRepository } from './ArtifactModel';

// Mirrors SessionModel.updateWithUpdateAccess.integration.test.ts for artifacts, whose write grant
// is permissions.canWrite and whose deletedAt is not managed by softDeletePlugin.

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let server: Awaited<ReturnType<typeof createMongoServer>>;

const OWNER = 'owner';
const WRITER = 'writer';
const READER = 'reader';
const ID = 'artifact-1';

const seed = () =>
  Artifact.create({
    id: ID,
    type: 'html',
    title: 'Original',
    version: 1,
    userId: OWNER,
    permissions: { canRead: [READER], canWrite: [WRITER], canDelete: [] },
    contentId: new mongoose.Types.ObjectId(),
    contentHash: 'h',
    contentSize: 1,
  });

const titleOf = async () => (await Artifact.collection.findOne({ id: ID }))?.title;

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

describe('ArtifactRepository.updateWithWriteAccess', () => {
  it.each([
    ['owner', OWNER],
    ['canWrite sharee', WRITER],
  ])('writes for the %s and returns the updated doc', async (_label, userId) => {
    await seed();

    const updated = await artifactRepository.updateWithWriteAccess(userId, { id: ID, title: 'Renamed' });

    expect(updated?.title).toBe('Renamed');
    expect(await titleOf()).toBe('Renamed');
  });

  it('returns null and writes nothing for a read-only sharee', async () => {
    await seed();

    expect(await artifactRepository.updateWithWriteAccess(READER, { id: ID, title: 'Renamed' })).toBeNull();
    expect(await titleOf()).toBe('Original');
  });

  it('returns null and writes nothing once the writer is removed from canWrite', async () => {
    await seed();
    await Artifact.collection.updateOne({ id: ID }, { $set: { 'permissions.canWrite': [] } });

    expect(await artifactRepository.updateWithWriteAccess(WRITER, { id: ID, title: 'Renamed' })).toBeNull();
    expect(await titleOf()).toBe('Original');
  });

  it('returns null and writes nothing on a deleted artifact, even for the owner', async () => {
    await seed();
    await Artifact.collection.updateOne({ id: ID }, { $set: { deletedAt: new Date() } });

    expect(await artifactRepository.updateWithWriteAccess(OWNER, { id: ID, title: 'Renamed' })).toBeNull();
    expect(await titleOf()).toBe('Original');
  });

  it('still writes on a row whose deletedAt was never set', async () => {
    await seed();
    await Artifact.collection.updateOne({ id: ID }, { $unset: { deletedAt: '' } });

    expect(await artifactRepository.updateWithWriteAccess(OWNER, { id: ID, title: 'Renamed' })).not.toBeNull();
  });
});
