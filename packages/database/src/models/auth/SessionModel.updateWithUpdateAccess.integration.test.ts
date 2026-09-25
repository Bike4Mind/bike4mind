import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../__test__/createMongoServer';
import { Session, sessionRepository } from './SessionModel';

/**
 * Real-MongoDB coverage for the write-time re-check: the auth predicate and the write are one
 * findOneAndUpdate, so a share revocation or soft-delete that lands after the authorizing read
 * turns the write into a no-op instead of letting it through.
 */

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let server: Awaited<ReturnType<typeof createMongoServer>>;

const OWNER = { id: 'owner', groups: [] as string[] };
const SHAREE = { id: 'sharee', groups: [] as string[] };
const GROUP_MEMBER = { id: 'member', groups: ['group-1'] };
const STRANGER = { id: 'stranger', groups: [] as string[] };

const seed = async (extra: Record<string, unknown> = {}) => {
  const s = await Session.create({
    name: 'Original',
    userId: OWNER.id,
    lastUpdated: new Date(),
    firstCreated: new Date(),
    users: [{ userId: SHAREE.id, permissions: ['read', 'update'] }],
    groups: [{ groupId: 'group-1', permissions: ['read', 'update'] }],
    ...extra,
  });
  return String(s._id);
};

const nameOf = async (id: string) => (await Session.collection.findOne({ _id: new mongoose.Types.ObjectId(id) }))?.name;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

afterEach(async () => {
  await Session.collection.deleteMany({});
});

describe('SessionRepository.updateWithUpdateAccess', () => {
  it.each([
    ['owner', OWNER],
    ['user sharee', SHAREE],
    ['group sharee', GROUP_MEMBER],
  ])('writes for the %s and returns the updated doc', async (_label, user) => {
    const id = await seed();

    const updated = await sessionRepository.updateWithUpdateAccess(user, { id, name: 'Renamed' });

    expect(updated?.name).toBe('Renamed');
    expect(await nameOf(id)).toBe('Renamed');
  });

  it('returns null and writes nothing once the sharee entry is removed', async () => {
    const id = await seed();
    await Session.updateOne({ _id: id }, { $set: { users: [] } });

    expect(await sessionRepository.updateWithUpdateAccess(SHAREE, { id, name: 'Renamed' })).toBeNull();
    expect(await nameOf(id)).toBe('Original');
  });

  it('returns null and writes nothing once the sharee is downgraded to read', async () => {
    const id = await seed();
    await Session.updateOne({ _id: id }, { $set: { users: [{ userId: SHAREE.id, permissions: ['read'] }] } });

    expect(await sessionRepository.updateWithUpdateAccess(SHAREE, { id, name: 'Renamed' })).toBeNull();
    expect(await nameOf(id)).toBe('Original');
  });

  it('returns null and writes nothing on a soft-deleted session, even for the owner', async () => {
    const id = await seed();
    await Session.updateOne({ _id: id }, { $set: { deletedAt: new Date() } });

    expect(await sessionRepository.updateWithUpdateAccess(OWNER, { id, name: 'Renamed' })).toBeNull();
    expect(await nameOf(id)).toBe('Original');
  });

  it('honours a global-write share only when includeGlobalWrite is passed', async () => {
    const id = await seed({ isGlobalWrite: true });

    expect(await sessionRepository.updateWithUpdateAccess(STRANGER, { id, name: 'Renamed' })).toBeNull();
    expect(await nameOf(id)).toBe('Original');

    const updated = await sessionRepository.updateWithUpdateAccess(
      STRANGER,
      { id, name: 'Renamed' },
      { includeGlobalWrite: true }
    );
    expect(updated?.name).toBe('Renamed');
  });

  it('returns null for an id that cannot address a row', async () => {
    expect(await sessionRepository.updateWithUpdateAccess(OWNER, { id: 'not-an-object-id', name: 'x' })).toBeNull();
  });
});
