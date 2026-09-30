import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../__test__/createMongoServer';
import { Project, projectRepository } from './ProjectModel';

// Mirrors SessionModel.updateWithUpdateAccess.integration.test.ts for projects.

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let server: Awaited<ReturnType<typeof createMongoServer>>;

const OWNER = { id: 'owner', groups: [] as string[] };
const SHAREE = { id: 'sharee', groups: [] as string[] };
const GROUP_MEMBER = { id: 'member', groups: ['group-1'] };

const seed = async () => {
  const p = await Project.create({
    name: 'Original',
    description: 'd',
    userId: OWNER.id,
    users: [{ userId: SHAREE.id, permissions: ['read', 'update'] }],
    groups: [{ groupId: 'group-1', permissions: ['read', 'update'] }],
  });
  return String(p._id);
};

const nameOf = async (id: string) => (await Project.collection.findOne({ _id: new mongoose.Types.ObjectId(id) }))?.name;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

afterEach(async () => {
  await Project.collection.deleteMany({});
});

describe('ProjectRepository.updateWithUpdateAccess', () => {
  it.each([
    ['owner', OWNER],
    ['user sharee', SHAREE],
    ['group sharee', GROUP_MEMBER],
  ])('writes for the %s and returns the updated doc', async (_label, user) => {
    const id = await seed();

    const updated = await projectRepository.updateWithUpdateAccess(user, { id, name: 'Renamed' });

    expect(updated?.name).toBe('Renamed');
    expect(await nameOf(id)).toBe('Renamed');
  });

  it('returns null and writes nothing once the sharee entry is removed', async () => {
    const id = await seed();
    await Project.updateOne({ _id: id }, { $set: { users: [] } });

    expect(await projectRepository.updateWithUpdateAccess(SHAREE, { id, name: 'Renamed' })).toBeNull();
    expect(await nameOf(id)).toBe('Original');
  });

  it('returns null and writes nothing for a read-only sharee', async () => {
    const id = await seed();
    await Project.updateOne({ _id: id }, { $set: { users: [{ userId: SHAREE.id, permissions: ['read'] }] } });

    expect(await projectRepository.updateWithUpdateAccess(SHAREE, { id, name: 'Renamed' })).toBeNull();
    expect(await nameOf(id)).toBe('Original');
  });

  it('returns null and writes nothing on a soft-deleted project, even for the owner', async () => {
    const id = await seed();
    await Project.updateOne({ _id: id }, { $set: { deletedAt: new Date() } });

    expect(await projectRepository.updateWithUpdateAccess(OWNER, { id, name: 'Renamed' })).toBeNull();
    expect(await nameOf(id)).toBe('Original');
  });

  it('returns null for an id that cannot address a row', async () => {
    expect(await projectRepository.updateWithUpdateAccess(OWNER, { id: 'not-an-object-id', name: 'x' })).toBeNull();
  });
});
