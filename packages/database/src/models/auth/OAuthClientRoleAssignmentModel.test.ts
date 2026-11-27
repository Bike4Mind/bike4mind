import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoServer } from '../../__test__/createMongoServer';
import { OAuthClientModel } from './OAuthClientModel';
import {
  OAuthClientRoleAssignmentModel,
  oauthClientRoleAssignmentRepository as repo,
} from './OAuthClientRoleAssignmentModel';
import { User } from './UserModel';

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await createMongoServer();
  await mongoose.connect(mongod.getUri());
  await OAuthClientRoleAssignmentModel.ensureIndexes();
}, 60000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
}, 60000);

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all([
    OAuthClientRoleAssignmentModel.deleteMany({}),
    User.deleteMany({}),
    OAuthClientModel.deleteMany({}),
  ]);
});

// Raw write: deletedAt is not on the User schema.
const makeUser = async (raw: Record<string, unknown> = {}) => {
  const user = await User.create({ username: `user-${Math.random()}`, name: 'Test User' });
  if (Object.keys(raw).length) await User.collection.updateOne({ _id: user._id }, { $set: raw });
  return String(user._id);
};

const makeClient = (clientId: string, keys: string[]) =>
  OAuthClientModel.create({
    clientId,
    clientSecretHash: 'hash',
    name: clientId,
    redirectUris: ['https://app.example.test/cb'],
    roles: keys.map(key => ({ key, label: key.toUpperCase() })),
  });

describe('assign / unassign', () => {
  it('creates once and is idempotent on repeat', async () => {
    const first = await repo.assign({ userId: 'u1', clientId: 'c1', role: 'admin', assignedBy: 'a1' });
    expect(first.created).toBe(true);
    expect(first.assignment).toMatchObject({ userId: 'u1', clientId: 'c1', role: 'admin', assignedBy: 'a1' });
    expect(first.assignment.assignedAt).toBeInstanceOf(Date);

    const again = await repo.assign({ userId: 'u1', clientId: 'c1', role: 'admin', assignedBy: 'a2' });
    expect(again.created).toBe(false);
    expect(again.assignment.assignedBy).toBe('a1');
    expect(await OAuthClientRoleAssignmentModel.countDocuments()).toBe(1);
  });

  it('retries once when a concurrent first assign wins the unique index', async () => {
    const original = OAuthClientRoleAssignmentModel.findOneAndUpdate.bind(OAuthClientRoleAssignmentModel);
    const spy = vi.spyOn(OAuthClientRoleAssignmentModel, 'findOneAndUpdate');
    spy.mockImplementationOnce(() => {
      throw Object.assign(new Error('dup'), { code: 11000 });
    });
    spy.mockImplementation(original);
    const result = await repo.assign({ userId: 'u1', clientId: 'c1', role: 'admin', assignedBy: 'a1' });
    expect(result.created).toBe(true);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('rethrows any other write error', async () => {
    vi.spyOn(OAuthClientRoleAssignmentModel, 'findOneAndUpdate').mockImplementationOnce(() => {
      throw new Error('boom');
    });
    await expect(repo.assign({ userId: 'u1', clientId: 'c1', role: 'admin', assignedBy: 'a1' })).rejects.toThrow(
      'boom'
    );
  });

  it('unassign deletes the row and reports whether one existed', async () => {
    await repo.assign({ userId: 'u1', clientId: 'c1', role: 'admin', assignedBy: 'a1' });
    expect(await repo.unassign('u1', 'c1', 'admin')).toBe(true);
    expect(await repo.unassign('u1', 'c1', 'admin')).toBe(false);
    expect(await OAuthClientRoleAssignmentModel.countDocuments()).toBe(0);
  });
});

describe('listing and bulk deletes', () => {
  it('lists holders per requested role, counted and capped earliest first, and by user, sorted', async () => {
    await repo.assign({ userId: 'u2', clientId: 'c1', role: 'viewer', assignedBy: 'a' });
    await repo.assign({ userId: 'u1', clientId: 'c1', role: 'admin', assignedBy: 'a' });
    await repo.assign({ userId: 'u3', clientId: 'c1', role: 'admin', assignedBy: 'a' });
    await repo.assign({ userId: 'u1', clientId: 'c0', role: 'viewer', assignedBy: 'a' });
    const byRole = await repo.listHoldersByClient('c1', ['admin', 'viewer', 'none'], 1);
    expect(byRole.map(r => ({ role: r.role, count: r.count, users: r.rows.map(row => row.userId) }))).toEqual([
      { role: 'admin', count: 2, users: ['u1'] },
      { role: 'viewer', count: 1, users: ['u2'] },
      { role: 'none', count: 0, users: [] },
    ]);
    expect((await repo.listByUser('u1')).map(r => `${r.clientId}:${r.role}`)).toEqual(['c0:viewer', 'c1:admin']);
  });

  it('deleteAllForClient removes one role or every role of the client only', async () => {
    await repo.assign({ userId: 'u1', clientId: 'c1', role: 'admin', assignedBy: 'a' });
    await repo.assign({ userId: 'u2', clientId: 'c1', role: 'viewer', assignedBy: 'a' });
    await repo.assign({ userId: 'u1', clientId: 'c2', role: 'admin', assignedBy: 'a' });
    expect(await repo.deleteAllForClient('c1', 'admin')).toBe(1);
    expect(await repo.deleteAllForClient('c1')).toBe(1);
    expect((await OAuthClientRoleAssignmentModel.find()).map(r => r.clientId)).toEqual(['c2']);
  });

  it('deleteAllForUser removes only that user', async () => {
    await repo.assign({ userId: 'u1', clientId: 'c1', role: 'admin', assignedBy: 'a' });
    await repo.assign({ userId: 'u1', clientId: 'c2', role: 'admin', assignedBy: 'a' });
    await repo.assign({ userId: 'u2', clientId: 'c1', role: 'admin', assignedBy: 'a' });
    expect(await repo.deleteAllForUser('u1')).toBe(2);
    expect(await OAuthClientRoleAssignmentModel.countDocuments({ userId: 'u2' })).toBe(1);
  });
});

describe('listRolesForUserAndClient', () => {
  it('returns the defined roles a usable user holds on that client only', async () => {
    const userId = await makeUser();
    await makeClient('c1', ['admin', 'viewer']);
    await makeClient('c2', ['admin']);
    await repo.assign({ userId, clientId: 'c1', role: 'viewer', assignedBy: 'a' });
    await repo.assign({ userId, clientId: 'c1', role: 'admin', assignedBy: 'a' });
    await repo.assign({ userId, clientId: 'c1', role: 'gone', assignedBy: 'a' });
    await repo.assign({ userId, clientId: 'c2', role: 'admin', assignedBy: 'a' });
    expect(await repo.listRolesForUserAndClient(userId, 'c1')).toEqual(['admin', 'viewer']);
  });

  it('returns [] for an unknown client', async () => {
    const userId = await makeUser();
    await repo.assign({ userId, clientId: 'nope', role: 'admin', assignedBy: 'a' });
    expect(await repo.listRolesForUserAndClient(userId, 'nope')).toEqual([]);
  });

  it.each([
    ['banned', { isBanned: true }],
    ['suspended', { moderation: { status: 'suspended' } }],
    ['disputed', { disputePending: true }],
    ['deleted', { deletedAt: new Date() }],
  ])('returns [] for a %s user', async (_label, overrides) => {
    const userId = await makeUser(overrides);
    await makeClient('c1', ['admin']);
    await repo.assign({ userId, clientId: 'c1', role: 'admin', assignedBy: 'a' });
    expect(await repo.listRolesForUserAndClient(userId, 'c1')).toEqual([]);
  });

  it('returns [] for a missing or malformed user id', async () => {
    await makeClient('c1', ['admin']);
    await repo.assign({ userId: 'not-an-id', clientId: 'c1', role: 'admin', assignedBy: 'a' });
    expect(await repo.listRolesForUserAndClient('not-an-id', 'c1')).toEqual([]);
    expect(await repo.listRolesForUserAndClient(new mongoose.Types.ObjectId().toString(), 'c1')).toEqual([]);
  });
});

describe('stored ObjectId spelling aliases', () => {
  const canonicalId = 'abcdef1234567890abcdef12';
  const alias = canonicalId.toUpperCase();
  const rawAssignment = (userId: string, clientId = 'c1', role = 'viewer') => ({
    userId,
    clientId,
    role,
    assignedBy: 'original',
    assignedAt: new Date('2026-01-01'),
  });

  it('reuses a stored alias without creating a second logical grant', async () => {
    await OAuthClientRoleAssignmentModel.collection.insertOne(rawAssignment(alias));
    const result = await repo.assign({ userId: canonicalId, clientId: 'c1', role: 'viewer', assignedBy: 'later' });
    expect(result.created).toBe(false);
    expect(result.assignment.assignedBy).toBe('original');
    expect(await OAuthClientRoleAssignmentModel.countDocuments()).toBe(1);
    expect(await repo.listByUser(canonicalId)).toHaveLength(1);
  });

  it('returns each defined claim once for existing aliases of a usable account', async () => {
    await User.create({ _id: new mongoose.Types.ObjectId(canonicalId), username: 'claim-user', name: 'Claim' });
    await makeClient('c1', ['viewer']);
    await OAuthClientRoleAssignmentModel.collection.insertMany([
      rawAssignment(alias),
      rawAssignment(canonicalId),
      rawAssignment(alias, 'c1', 'removed'),
      rawAssignment(alias, 'c2', 'admin'),
    ]);
    expect(await repo.listRolesForUserAndClient(canonicalId, 'c1')).toEqual(['viewer']);
    expect(await repo.listRolesForUserAndClient(alias, 'c1')).toEqual(['viewer']);
  });

  it('unassigns every alias of one grant while retaining other clients, roles and users', async () => {
    await OAuthClientRoleAssignmentModel.collection.insertMany([
      rawAssignment(canonicalId),
      rawAssignment(alias),
      rawAssignment(alias, 'c2'),
      rawAssignment(alias, 'c1', 'admin'),
      rawAssignment('abcdef1234567890abcdef13'),
    ]);
    expect(await repo.unassign(canonicalId, 'c1', 'viewer')).toBe(true);
    expect(await OAuthClientRoleAssignmentModel.countDocuments()).toBe(3);
    expect(
      await OAuthClientRoleAssignmentModel.countDocuments({
        clientId: 'c1',
        role: 'viewer',
        userId: { $in: [canonicalId, alias] },
      })
    ).toBe(0);
  });

  it('purges all stored spellings after the actual user row is deleted', async () => {
    await User.create({ _id: new mongoose.Types.ObjectId(canonicalId), username: 'purged-user', name: 'Purged' });
    await OAuthClientRoleAssignmentModel.collection.insertMany([
      rawAssignment(canonicalId),
      rawAssignment(alias),
      rawAssignment(alias, 'c2'),
      rawAssignment('abcdef1234567890abcdef13'),
    ]);
    await User.deleteOne({ _id: canonicalId });
    expect(await repo.deleteAllForUser(canonicalId)).toBe(3);
    expect(await repo.deleteAllForUser(alias)).toBe(0);
    expect(await OAuthClientRoleAssignmentModel.countDocuments()).toBe(1);
    expect((await OAuthClientRoleAssignmentModel.findOne())?.userId).toBe('abcdef1234567890abcdef13');
  });
});
