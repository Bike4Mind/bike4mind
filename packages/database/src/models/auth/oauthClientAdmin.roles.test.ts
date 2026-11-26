import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { ZodError } from 'zod';
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
  OAUTH_CLIENT_MAX_ROLES,
  OAUTH_CLIENT_ROLE_HOLDERS_SHOWN,
} from '@bike4mind/common';
import { createMongoServer } from '../../__test__/createMongoServer';
import { OAuthClientModel, type IOAuthClientDocument } from './OAuthClientModel';
import { OAuthClientRoleAssignmentModel, oauthClientRoleAssignmentRepository } from './OAuthClientRoleAssignmentModel';
import { User } from './UserModel';
import {
  addOAuthClientRole,
  assignOAuthClientRole,
  createOAuthClient,
  listOAuthClientRoles,
  listUserOAuthClientRoles,
  removeOAuthClientRole,
  toOAuthClientView,
  unassignOAuthClientRole,
} from './oauthClientAdmin';

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
}, 60000);

afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
}, 60000);

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all([
    OAuthClientModel.deleteMany({}),
    OAuthClientRoleAssignmentModel.deleteMany({}),
    User.deleteMany({}),
  ]);
});

let seq = 0;
const makeClient = async (name = `App ${++seq}`) =>
  (await createOAuthClient({ name, redirectUris: ['https://app.example.test/cb'] })).client;
// Raw write: deletedAt is not on the schema and `name` is required there, but stored rows can lack both.
const makeUser = async (raw: Record<string, unknown> = {}) => {
  const user = await User.create({
    username: `user-${Math.random()}`,
    name: 'Ada',
    email: `ada-${++seq}@example.test`,
  });
  if (Object.keys(raw).length) await User.collection.updateOne({ _id: user._id }, { $set: raw });
  return String(user._id);
};
const missingId = () => new mongoose.Types.ObjectId().toString();

describe('toOAuthClientView roles', () => {
  it('defaults a document without roles to []', () => {
    const doc = { id: 'x', clientId: 'c', name: 'n', isActive: true } as unknown as IOAuthClientDocument;
    expect(toOAuthClientView(doc).roles).toEqual([]);
  });
});

describe('addOAuthClientRole', () => {
  it('adds a trimmed role and returns the updated client', async () => {
    const client = await makeClient();
    const result = await addOAuthClientRole(client.id, { key: ' admin ', label: ' Administrator ' });
    expect(result.role).toEqual({ key: 'admin', label: 'Administrator' });
    expect(result.client.roles).toEqual([{ key: 'admin', label: 'Administrator' }]);
  });

  it('rejects a duplicate key with a ConflictError', async () => {
    const client = await makeClient();
    await addOAuthClientRole(client.id, { key: 'admin', label: 'Admin' });
    await expect(addOAuthClientRole(client.id, { key: 'admin', label: 'Other' })).rejects.toBeInstanceOf(ConflictError);
  });

  it('rejects a role past the limit', async () => {
    const client = await makeClient();
    await OAuthClientModel.updateOne(
      { _id: client.id },
      { $set: { roles: Array.from({ length: OAUTH_CLIENT_MAX_ROLES }, (_, i) => ({ key: `r${i}`, label: 'R' })) } }
    );
    await expect(addOAuthClientRole(client.id, { key: 'extra', label: 'Extra' })).rejects.toBeInstanceOf(
      BadRequestError
    );
  });

  it.each([
    [{ key: 'Admin', label: 'A' }],
    [{ key: '1admin', label: 'A' }],
    [{ key: 'a'.repeat(33), label: 'A' }],
    [{ key: 'admin', label: '' }],
    [{ key: 'admin', label: 'x'.repeat(65) }],
  ])('rejects invalid input %j', async input => {
    const client = await makeClient();
    await expect(addOAuthClientRole(client.id, input)).rejects.toBeInstanceOf(ZodError);
  });

  it('404s for a malformed or unknown client id', async () => {
    await expect(addOAuthClientRole('nope', { key: 'admin', label: 'A' })).rejects.toBeInstanceOf(NotFoundError);
    await expect(addOAuthClientRole(missingId(), { key: 'admin', label: 'A' })).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('re-adding a removed role', () => {
  it('does not bring back assignments left from before', async () => {
    const client = await makeClient();
    await oauthClientRoleAssignmentRepository.assign({
      userId: 'u-stale',
      clientId: client.clientId,
      role: 'admin',
      assignedBy: 'a1',
    });
    await OAuthClientRoleAssignmentModel.updateOne({ userId: 'u-stale' }, { assignedAt: new Date('2026-01-01') });
    await addOAuthClientRole(client.id, { key: 'admin', label: 'Admin' });
    expect(await OAuthClientRoleAssignmentModel.countDocuments({ clientId: client.clientId })).toBe(0);
  });
});

describe('removeOAuthClientRole', () => {
  it('removes the role and deletes its assignments on that client only', async () => {
    const client = await makeClient();
    const other = await makeClient();
    await addOAuthClientRole(client.id, { key: 'admin', label: 'Admin' });
    await addOAuthClientRole(client.id, { key: 'viewer', label: 'Viewer' });
    await addOAuthClientRole(other.id, { key: 'admin', label: 'Admin' });
    const userId = await makeUser();
    for (const [clientId, role] of [
      [client.clientId, 'admin'],
      [client.clientId, 'viewer'],
      [other.clientId, 'admin'],
    ]) {
      await assignOAuthClientRole({ userId, clientId, role, assignedBy: 'a1' });
    }

    const result = await removeOAuthClientRole(client.id, 'admin');
    expect(result.role).toEqual({ key: 'admin', label: 'Admin' });
    expect(result.removedAssignments).toBe(1);
    expect(result.client.roles).toEqual([{ key: 'viewer', label: 'Viewer' }]);
    expect((await OAuthClientModel.findById(client.id))?.roles.map(r => r.key)).toEqual(['viewer']);
    const left = await OAuthClientRoleAssignmentModel.find().sort({ clientId: 1, role: 1 });
    expect(left.map(r => `${r.clientId}:${r.role}`).sort()).toEqual(
      [`${client.clientId}:viewer`, `${other.clientId}:admin`].sort()
    );
  });

  it('404s for an unknown role, client or malformed id', async () => {
    const client = await makeClient();
    await expect(removeOAuthClientRole(client.id, 'admin')).rejects.toThrow('Role not found on this client');
    await expect(removeOAuthClientRole(missingId(), 'admin')).rejects.toThrow('OAuth client not found');
    await expect(removeOAuthClientRole('nope', 'admin')).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('listOAuthClientRoles', () => {
  it('lists roles and holders with their identity, leaving out undefined roles', async () => {
    const client = await makeClient();
    await addOAuthClientRole(client.id, { key: 'admin', label: 'Admin' });
    const userId = await makeUser();
    const bare = await makeUser({ email: '', name: '' });
    await assignOAuthClientRole({ userId, clientId: client.clientId, role: 'admin', assignedBy: 'a1' });
    await assignOAuthClientRole({ userId: bare, clientId: client.clientId, role: 'admin', assignedBy: 'a1' });
    await oauthClientRoleAssignmentRepository.assign({
      userId,
      clientId: client.clientId,
      role: 'stale',
      assignedBy: 'a1',
    });
    const gone = missingId();
    await oauthClientRoleAssignmentRepository.assign({
      userId: gone,
      clientId: client.clientId,
      role: 'admin',
      assignedBy: 'a1',
    });

    const result = await listOAuthClientRoles(client.id);
    expect(result.roles).toEqual([{ key: 'admin', label: 'Admin' }]);
    expect(result.holders).toHaveLength(3);
    expect(result.holders.find(h => h.userId === userId)).toEqual({
      userId,
      role: 'admin',
      email: expect.stringMatching(/^ada-\d+@example\.test$/),
      name: 'Ada',
      assignedBy: 'a1',
      assignedAt: expect.any(String),
    });
    expect(result.holders.find(h => h.userId === bare)).toMatchObject({ email: null, name: null });
    expect(result.holders.find(h => h.userId === gone)).toMatchObject({ email: null, name: null });
    expect(result.holderCounts).toEqual({ admin: 3 });
  });

  it('lists at most OAUTH_CLIENT_ROLE_HOLDERS_SHOWN holders per role but counts them all', async () => {
    const client = await makeClient();
    await addOAuthClientRole(client.id, { key: 'member', label: 'Member' });
    await OAuthClientRoleAssignmentModel.insertMany(
      Array.from({ length: OAUTH_CLIENT_ROLE_HOLDERS_SHOWN + 2 }, (_, i) => ({
        userId: new mongoose.Types.ObjectId().toString(),
        clientId: client.clientId,
        role: 'member',
        assignedBy: 'a1',
      }))
    );
    const result = await listOAuthClientRoles(client.id);
    expect(result.holders).toHaveLength(OAUTH_CLIENT_ROLE_HOLDERS_SHOWN);
    expect(result.holderCounts).toEqual({ member: OAUTH_CLIENT_ROLE_HOLDERS_SHOWN + 2 });
  });

  it('404s for an unknown client', async () => {
    await expect(listOAuthClientRoles(missingId())).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('assignOAuthClientRole / unassignOAuthClientRole', () => {
  it('assigns idempotently and unassigns with a hard delete', async () => {
    const client = await makeClient();
    await addOAuthClientRole(client.id, { key: 'admin', label: 'Admin' });
    const userId = await makeUser();

    const first = await assignOAuthClientRole({ userId, clientId: client.clientId, role: 'admin', assignedBy: 'a1' });
    expect(first).toMatchObject({
      created: true,
      role: { key: 'admin', label: 'Admin' },
      user: { id: userId, email: expect.stringMatching(/^ada-\d+@example\.test$/), name: 'Ada' },
      client: { clientId: client.clientId },
    });
    const again = await assignOAuthClientRole({ userId, clientId: client.clientId, role: 'admin', assignedBy: 'a2' });
    expect(again.created).toBe(false);

    const removed = await unassignOAuthClientRole({ userId, clientId: client.clientId, role: 'admin' });
    expect(removed.role).toEqual({ key: 'admin', label: 'Admin' });
    expect(await OAuthClientRoleAssignmentModel.countDocuments()).toBe(0);
    await expect(unassignOAuthClientRole({ userId, clientId: client.clientId, role: 'admin' })).rejects.toThrow(
      'This user does not hold that role'
    );
  });

  it('rejects a role the client does not define', async () => {
    const client = await makeClient();
    const userId = await makeUser();
    await expect(
      assignOAuthClientRole({ userId, clientId: client.clientId, role: 'admin', assignedBy: 'a1' })
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it('404s for an unknown, malformed or deleted user and an unknown client', async () => {
    const client = await makeClient();
    await addOAuthClientRole(client.id, { key: 'admin', label: 'Admin' });
    const deleted = await makeUser({ deletedAt: new Date() });
    for (const userId of [missingId(), 'nope', deleted]) {
      await expect(
        assignOAuthClientRole({ userId, clientId: client.clientId, role: 'admin', assignedBy: 'a1' })
      ).rejects.toThrow('User not found');
    }
    const userId = await makeUser();
    await expect(
      assignOAuthClientRole({ userId, clientId: 'b4m_none', role: 'admin', assignedBy: 'a1' })
    ).rejects.toThrow('OAuth client not found');
    await expect(unassignOAuthClientRole({ userId, clientId: 'b4m_none', role: 'admin' })).rejects.toThrow(
      'OAuth client not found'
    );
  });

  it('unassigns a role the client no longer defines, naming it by key', async () => {
    const client = await makeClient();
    const userId = await makeUser({ email: '', name: '' });
    await oauthClientRoleAssignmentRepository.assign({
      userId,
      clientId: client.clientId,
      role: 'stale',
      assignedBy: 'a',
    });
    const result = await unassignOAuthClientRole({ userId, clientId: client.clientId, role: 'stale' });
    expect(result.role).toEqual({ key: 'stale', label: 'stale' });
    expect(result.user).toEqual({ id: userId, email: null, name: null });
  });
});

describe('listUserOAuthClientRoles', () => {
  it('lists clients offering roles or holding one for the user, with labelled assignments', async () => {
    const offering = await makeClient('B app');
    await addOAuthClientRole(offering.id, { key: 'admin', label: 'Admin' });
    await addOAuthClientRole(offering.id, { key: 'viewer', label: 'Viewer' });
    const plain = await makeClient('C plain');
    await makeClient('D unrelated');
    const userId = await makeUser();
    await assignOAuthClientRole({ userId, clientId: offering.clientId, role: 'viewer', assignedBy: 'a1' });
    await oauthClientRoleAssignmentRepository.assign({
      userId,
      clientId: plain.clientId,
      role: 'stale',
      assignedBy: 'a',
    });

    const result = await listUserOAuthClientRoles(userId);
    expect(result.map(r => r.clientName)).toEqual(['B app', 'C plain']);
    expect(result[0]).toEqual({
      clientId: offering.clientId,
      clientName: 'B app',
      isActive: true,
      roles: [
        { key: 'admin', label: 'Admin' },
        { key: 'viewer', label: 'Viewer' },
      ],
      assigned: [{ role: 'viewer', label: 'Viewer', assignedBy: 'a1', assignedAt: expect.any(String) }],
    });
    expect(result[1].assigned).toEqual([]);
  });

  it('404s for an unknown user', async () => {
    await expect(listUserOAuthClientRoles(missingId())).rejects.toBeInstanceOf(NotFoundError);
  });
});
