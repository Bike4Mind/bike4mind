import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { ZodError } from 'zod';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  OAUTH_CLIENT_MAX_ROLES,
  OAUTH_CLIENT_ROLE_HOLDERS_SHOWN,
} from '@bike4mind/common';
import { createMongoReplSet, settleAutoIndexBuilds } from '../../__test__/createMongoServer';
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

let server: Awaited<ReturnType<typeof createMongoReplSet>>;

beforeAll(async () => {
  server = await createMongoReplSet();
  await mongoose.connect(server.getUri(), { autoIndex: false, monitorCommands: true });
  await settleAutoIndexBuilds(mongoose);
  await OAuthClientModel.createIndexes();
  await OAuthClientRoleAssignmentModel.createIndexes();
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
    expect(result.removedUserIds).toEqual([userId]);
    expect(result.client.roles).toEqual([{ key: 'viewer', label: 'Viewer' }]);
    expect((await OAuthClientModel.findById(client.id))?.roles.map(r => r.key)).toEqual(['viewer']);
    const left = await OAuthClientRoleAssignmentModel.find().sort({ clientId: 1, role: 1 });
    expect(left.map(r => `${r.clientId}:${r.role}`).sort()).toEqual(
      [`${client.clientId}:viewer`, `${other.clientId}:admin`].sort()
    );
  });

  it('refuses a delegated admin when a holder has admin access, and lets a full admin through', async () => {
    const client = await makeClient();
    await addOAuthClientRole(client.id, { key: 'admin', label: 'Admin' });
    const plain = await makeUser();
    const privileged = await makeUser({ adminPermissions: ['support:read'] });
    for (const userId of [plain, privileged]) {
      await assignOAuthClientRole({ userId, clientId: client.clientId, role: 'admin', assignedBy: 'a1' });
    }
    const delegate = { isAdmin: false, adminPermissions: ['settings:manage'] } as const;

    await expect(removeOAuthClientRole(client.id, 'admin', { actor: delegate })).rejects.toBeInstanceOf(ForbiddenError);
    expect((await OAuthClientModel.findById(client.id))?.roles.map(r => r.key)).toEqual(['admin']);
    expect(await OAuthClientRoleAssignmentModel.countDocuments({ clientId: client.clientId })).toBe(2);

    const result = await removeOAuthClientRole(client.id, 'admin', { actor: { isAdmin: true } });
    expect(result.removedAssignments).toBe(2);
  });

  it('lets a delegated admin remove a role held only by ordinary accounts', async () => {
    const client = await makeClient();
    await addOAuthClientRole(client.id, { key: 'admin', label: 'Admin' });
    await assignOAuthClientRole({
      userId: await makeUser(),
      clientId: client.clientId,
      role: 'admin',
      assignedBy: 'a1',
    });
    const result = await removeOAuthClientRole(client.id, 'admin', {
      actor: { isAdmin: false, adminPermissions: ['settings:manage'] },
    });
    expect(result.removedAssignments).toBe(1);
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

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {
    resolve = done;
  });
  return { promise, resolve };
};

const isParentFence = (event: { commandName: string; command: Record<string, unknown> }) => {
  if (event.commandName !== 'findAndModify' || event.command.findAndModify !== OAuthClientModel.collection.name)
    return false;
  const update = event.command.update;
  if (typeof update !== 'object' || update === null || !('$inc' in update)) return false;
  const increment = update.$inc;
  return typeof increment === 'object' && increment !== null && 'roleMutationVersion' in increment;
};

const trackParentWrites = () => {
  const writes: Record<string, unknown>[] = [];
  const client = mongoose.connection.getClient();
  const listener = (event: { commandName: string; command: Record<string, unknown> }) => {
    if (isParentFence(event)) writes.push(event.command);
  };
  client.on('commandStarted', listener);
  return { writes, stop: () => client.off('commandStarted', listener) };
};

const nextParentWrite = () => {
  const entered = deferred();
  const client = mongoose.connection.getClient();
  const listener = (event: { commandName: string; command: Record<string, unknown> }) => {
    if (isParentFence(event)) entered.resolve();
  };
  client.on('commandStarted', listener);
  let timer: ReturnType<typeof setTimeout>;
  const promise = Promise.race([
    entered.promise,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Expected competing role-client write')), 10000);
    }),
  ]).finally(() => {
    clearTimeout(timer);
    client.off('commandStarted', listener);
  });
  return promise;
};

describe('role reset transaction ordering', () => {
  it('rejects a grant resumed after the user delete and assignment purge complete', async () => {
    const client = await makeClient();
    await addOAuthClientRole(client.id, { key: 'admin', label: 'Admin' });
    const userId = await makeUser();
    const entered = deferred();
    const release = deferred();
    const findAndUpdate = OAuthClientModel.findOneAndUpdate.bind(OAuthClientModel);
    vi.spyOn(OAuthClientModel, 'findOneAndUpdate').mockImplementationOnce((...args) => {
      const query = findAndUpdate(...args);
      const execute = query.exec.bind(query);
      query.exec = async () => {
        entered.resolve();
        await release.promise;
        return execute();
      };
      return query;
    });
    const pending = assignOAuthClientRole({ userId, clientId: client.clientId, role: 'admin', assignedBy: 'a' });
    try {
      await entered.promise;
      await User.deleteOne({ _id: userId });
      await oauthClientRoleAssignmentRepository.deleteAllForUser(userId);
    } finally {
      release.resolve();
    }
    await expect(pending).rejects.toBeInstanceOf(NotFoundError);
    expect(await OAuthClientRoleAssignmentModel.countDocuments({ userId })).toBe(0);
    expect((await listOAuthClientRoles(client.id)).holders).toEqual([]);
  });

  it('orders an admitted grant before user deletion and its assignment purge', async () => {
    const client = await makeClient();
    await addOAuthClientRole(client.id, { key: 'admin', label: 'Admin' });
    const userId = await makeUser();
    const entered = deferred();
    const release = deferred();
    const assign = oauthClientRoleAssignmentRepository.assign.bind(oauthClientRoleAssignmentRepository);
    vi.spyOn(oauthClientRoleAssignmentRepository, 'assign').mockImplementationOnce(async (...args) => {
      entered.resolve();
      await release.promise;
      return assign(...args);
    });
    const pending = assignOAuthClientRole({ userId, clientId: client.clientId, role: 'admin', assignedBy: 'a' });
    let deletionAttempted = false;
    const databaseClient = mongoose.connection.getClient();
    const listener = (event: { commandName: string; command: Record<string, unknown> }) => {
      if (event.commandName === 'delete' && event.command.delete === User.collection.name) {
        deletionAttempted = true;
      }
    };
    databaseClient.on('commandStarted', listener);
    const eraseUser = async () => {
      await User.deleteOne({ _id: userId });
      await oauthClientRoleAssignmentRepository.deleteAllForUser(userId);
    };
    let deletion: Promise<void> | undefined;
    try {
      await entered.promise;
      deletion = eraseUser();
      await vi.waitFor(() => expect(deletionAttempted).toBe(true));
    } finally {
      release.resolve();
      databaseClient.off('commandStarted', listener);
      await pending;
      await deletion;
    }
    expect(await User.exists({ _id: userId })).toBeNull();
    expect(await OAuthClientRoleAssignmentModel.countDocuments({ userId })).toBe(0);
    expect((await listOAuthClientRoles(client.id)).holders).toEqual([]);
  });

  it('orders a validated assignment before removal and clears it before re-add', async () => {
    const client = await makeClient();
    await addOAuthClientRole(client.id, { key: 'admin', label: 'Old' });
    const userId = await makeUser();
    const entered = deferred();
    const release = deferred();
    const tracked = trackParentWrites();
    const assign = oauthClientRoleAssignmentRepository.assign.bind(oauthClientRoleAssignmentRepository);
    vi.spyOn(oauthClientRoleAssignmentRepository, 'assign').mockImplementationOnce(async (...args) => {
      entered.resolve();
      await release.promise;
      return assign(...args);
    });
    const pending = assignOAuthClientRole({ userId, clientId: client.clientId, role: 'admin', assignedBy: 'a' });
    let removal: ReturnType<typeof removeOAuthClientRole> | undefined;
    try {
      await entered.promise;
      expect(tracked.writes).toHaveLength(1);
      const attempted = nextParentWrite();
      removal = removeOAuthClientRole(client.id, 'admin');
      await attempted;
    } finally {
      release.resolve();
      tracked.stop();
      await pending;
      await removal;
    }
    await addOAuthClientRole(client.id, { key: 'admin', label: 'New' });
    expect(await OAuthClientRoleAssignmentModel.countDocuments({ clientId: client.clientId })).toBe(0);
    expect(await oauthClientRoleAssignmentRepository.listRolesForUserAndClient(userId, client.clientId)).toEqual([]);
    expect((await listOAuthClientRoles(client.id)).holders).toEqual([]);
    expect((await listUserOAuthClientRoles(userId))[0]?.assigned).toEqual([]);
  });

  it('commits old removal cleanup before re-add and preserves the fresh grant', async () => {
    const client = await makeClient();
    await addOAuthClientRole(client.id, { key: 'admin', label: 'Old' });
    const userId = await makeUser();
    const entered = deferred();
    const release = deferred();
    const tracked = trackParentWrites();
    const cleanup = oauthClientRoleAssignmentRepository.deleteAllForClient.bind(oauthClientRoleAssignmentRepository);
    vi.spyOn(oauthClientRoleAssignmentRepository, 'deleteAllForClient').mockImplementationOnce(async (...args) => {
      entered.resolve();
      await release.promise;
      return cleanup(...args);
    });
    const pending = removeOAuthClientRole(client.id, 'admin');
    let addition: ReturnType<typeof addOAuthClientRole> | undefined;
    try {
      await entered.promise;
      expect(tracked.writes).toHaveLength(1);
      const attempted = nextParentWrite();
      addition = addOAuthClientRole(client.id, { key: 'admin', label: 'New' });
      await attempted;
    } finally {
      release.resolve();
      tracked.stop();
      await pending;
      await addition;
    }
    await assignOAuthClientRole({ userId, clientId: client.clientId, role: 'admin', assignedBy: 'a' });
    expect(await oauthClientRoleAssignmentRepository.listRolesForUserAndClient(userId, client.clientId)).toEqual([
      'admin',
    ]);
    expect((await listOAuthClientRoles(client.id)).holders).toHaveLength(1);
    expect((await listUserOAuthClientRoles(userId))[0]?.assigned[0]?.label).toBe('New');
  });

  it('rolls back the definition and cleanup when removal fails after deleting assignments', async () => {
    const client = await makeClient();
    await addOAuthClientRole(client.id, { key: 'admin', label: 'Admin' });
    const userId = await makeUser();
    await assignOAuthClientRole({ userId, clientId: client.clientId, role: 'admin', assignedBy: 'a' });
    const cleanup = oauthClientRoleAssignmentRepository.deleteAllForClient.bind(oauthClientRoleAssignmentRepository);
    const stub = vi
      .spyOn(oauthClientRoleAssignmentRepository, 'deleteAllForClient')
      .mockImplementationOnce(async (...args) => {
        await cleanup(...args);
        throw new Error('cleanup failed');
      });
    await expect(removeOAuthClientRole(client.id, 'admin')).rejects.toThrow('cleanup failed');
    stub.mockRestore();
    expect((await OAuthClientModel.findById(client.id))?.roles.map(role => role.key)).toEqual(['admin']);
    expect(await OAuthClientRoleAssignmentModel.countDocuments({ clientId: client.clientId })).toBe(1);
    await removeOAuthClientRole(client.id, 'admin');
    expect(await OAuthClientRoleAssignmentModel.countDocuments({ clientId: client.clientId })).toBe(0);
  });

  it('rolls back a failed addition and clears future-dated residual assignments on retry', async () => {
    const client = await makeClient();
    await OAuthClientRoleAssignmentModel.create({
      userId: 'stale',
      clientId: client.clientId,
      role: 'admin',
      assignedBy: 'a',
      assignedAt: new Date('2100-01-01'),
    });
    const cleanup = oauthClientRoleAssignmentRepository.deleteAllForClient.bind(oauthClientRoleAssignmentRepository);
    const stub = vi
      .spyOn(oauthClientRoleAssignmentRepository, 'deleteAllForClient')
      .mockImplementationOnce(async (...args) => {
        await cleanup(...args);
        throw new Error('cleanup failed');
      });
    await expect(addOAuthClientRole(client.id, { key: 'admin', label: 'New' })).rejects.toThrow('cleanup failed');
    stub.mockRestore();
    expect((await OAuthClientModel.findById(client.id))?.roles).toHaveLength(0);
    expect(await OAuthClientRoleAssignmentModel.countDocuments({ clientId: client.clientId })).toBe(1);
    await addOAuthClientRole(client.id, { key: 'admin', label: 'New' });
    expect(await OAuthClientRoleAssignmentModel.countDocuments({ clientId: client.clientId })).toBe(0);
  });

  it('rolls back an inserted assignment and preserves public timestamps on grant and revoke', async () => {
    const client = await makeClient();
    const added = await addOAuthClientRole(client.id, { key: 'admin', label: 'Admin' });
    const userId = await makeUser();
    const originalUser = await User.collection.findOne({ _id: new mongoose.Types.ObjectId(userId) });
    const assign = oauthClientRoleAssignmentRepository.assign.bind(oauthClientRoleAssignmentRepository);
    const stub = vi.spyOn(oauthClientRoleAssignmentRepository, 'assign').mockImplementationOnce(async (...args) => {
      await assign(...args);
      throw new Error('assignment failed');
    });
    await expect(
      assignOAuthClientRole({ userId, clientId: client.clientId, role: 'admin', assignedBy: 'a' })
    ).rejects.toThrow('assignment failed');
    stub.mockRestore();
    expect(await OAuthClientRoleAssignmentModel.countDocuments({ clientId: client.clientId })).toBe(0);
    const rolledBackUser = await User.collection.findOne({ _id: new mongoose.Types.ObjectId(userId) });
    expect(rolledBackUser?.__v).toBe(originalUser?.__v);
    const granted = await assignOAuthClientRole({ userId, clientId: client.clientId, role: 'admin', assignedBy: 'a' });
    const revoked = await unassignOAuthClientRole({ userId, clientId: client.clientId, role: 'admin' });
    expect(granted.client.updatedAt).toBe(added.client.updatedAt);
    expect(revoked.client.updatedAt).toBe(added.client.updatedAt);
    const admittedUser = await User.collection.findOne({ _id: new mongoose.Types.ObjectId(userId) });
    expect(admittedUser?.updatedAt).toEqual(originalUser?.updatedAt);
    const stored = await OAuthClientModel.findById(client.id).lean();
    expect(stored).not.toHaveProperty('roleMutationVersion');
    expect(granted.client).not.toHaveProperty('roleMutationVersion');
    expect(
      (await OAuthClientModel.collection.findOne({ clientId: client.clientId }))?.roleMutationVersion
    ).toBeGreaterThan(0);
  });

  it('serializes concurrent idempotent grants without replacing the first actor or time', async () => {
    const client = await makeClient();
    await addOAuthClientRole(client.id, { key: 'admin', label: 'Admin' });
    const userId = await makeUser();
    const results = await Promise.all(
      ['a', 'b'].map(assignedBy =>
        assignOAuthClientRole({ userId, clientId: client.clientId, role: 'admin', assignedBy })
      )
    );
    expect(results.filter(result => result.created)).toHaveLength(1);
    const row = await OAuthClientRoleAssignmentModel.findOne({ clientId: client.clientId }).lean();
    await assignOAuthClientRole({ userId, clientId: client.clientId, role: 'admin', assignedBy: 'later' });
    const same = await OAuthClientRoleAssignmentModel.findOne({ clientId: client.clientId }).lean();
    expect(same?.assignedBy).toBe(row?.assignedBy);
    expect(same?.assignedAt).toEqual(row?.assignedAt);
    expect(await OAuthClientRoleAssignmentModel.countDocuments({ clientId: client.clientId })).toBe(1);
  });
});

describe('role assignments use the resolved user identity', () => {
  const canonicalId = 'abcdef1234567890abcdef12';
  const makeCanonicalUser = () =>
    User.create({ _id: new mongoose.Types.ObjectId(canonicalId), username: 'canonical-user', name: 'Canonical' });

  it('stores one canonical assignment for alternate ObjectId spellings', async () => {
    await makeCanonicalUser();
    const client = await makeClient();
    await addOAuthClientRole(client.id, { key: 'viewer', label: 'Viewer' });
    const params = {
      userId: canonicalId.toUpperCase(),
      clientId: client.clientId,
      role: 'viewer',
      assignedBy: 'admin',
    };
    const first = await assignOAuthClientRole(params);
    expect(first.user.id).toBe(canonicalId);
    expect(await OAuthClientRoleAssignmentModel.findOne().lean()).toMatchObject({ userId: canonicalId });
    expect((await listUserOAuthClientRoles(canonicalId))[0]?.assigned).toHaveLength(1);
    expect((await listUserOAuthClientRoles(canonicalId.toUpperCase()))[0]?.assigned).toHaveLength(1);
    expect((await assignOAuthClientRole({ ...params, userId: canonicalId })).created).toBe(false);
    expect(await OAuthClientRoleAssignmentModel.countDocuments()).toBe(1);
    expect((await unassignOAuthClientRole(params)).user.id).toBe(canonicalId);
    expect(await OAuthClientRoleAssignmentModel.countDocuments()).toBe(0);
  });

  it('resolves holder details for an assignment stored with an uppercase identity', async () => {
    await makeCanonicalUser();
    const client = await makeClient();
    await addOAuthClientRole(client.id, { key: 'viewer', label: 'Viewer' });
    await OAuthClientRoleAssignmentModel.collection.insertOne({
      userId: canonicalId.toUpperCase(),
      clientId: client.clientId,
      role: 'viewer',
      assignedBy: 'original',
      assignedAt: new Date('2026-01-01'),
    });
    expect((await listOAuthClientRoles(client.id)).holders).toEqual([
      expect.objectContaining({ userId: canonicalId, name: 'Canonical' }),
    ]);
  });

  it('lists and unassigns an existing canonical grant through an uppercase user ID', async () => {
    await makeCanonicalUser();
    const client = await makeClient();
    await addOAuthClientRole(client.id, { key: 'viewer', label: 'Viewer' });
    await assignOAuthClientRole({
      userId: canonicalId,
      clientId: client.clientId,
      role: 'viewer',
      assignedBy: 'admin',
    });
    expect((await listUserOAuthClientRoles(canonicalId.toUpperCase()))[0]?.assigned).toHaveLength(1);
    await unassignOAuthClientRole({ userId: canonicalId.toUpperCase(), clientId: client.clientId, role: 'viewer' });
    expect(await OAuthClientRoleAssignmentModel.countDocuments()).toBe(0);
  });
});
