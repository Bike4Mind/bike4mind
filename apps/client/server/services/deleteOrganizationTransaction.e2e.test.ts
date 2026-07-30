import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
// createMongoReplSet is not exported from the package barrel / dist; deep-import the source.
import { createMongoReplSet } from '../../../../packages/database/src/__test__/createMongoServer';
import {
  Group,
  Organization,
  User,
  organizationRepository,
  groupRepository,
  userRepository,
  withTransaction,
} from '@bike4mind/database';
import { organizationService } from '@bike4mind/services';

/**
 * Transactional guard for #1219: proves the org soft-delete participates in the caller's
 * transaction rather than escaping it.
 *
 * Needs a REAL replica set. Against the standalone createMongoServer used elsewhere,
 * withTransaction degrades to unwrapped writes, so a write that escapes the session is
 * indistinguishable from one that joins it and this suite would pass on the broken code.
 *
 * The bug this pins: repository `delete()` routes through the soft-delete plugin's raw-driver
 * static, which transactionAsyncLocalStorage cannot reach. The org row would commit immediately
 * while the group soft-deletes and member purge rolled back - leaving an organization that is
 * already gone, its groups live, and every membership intact. Because `get()` filters `deletedAt`,
 * the retry then 404s forever. Consumes the built dist, so `pnpm turbo:core:build` must be current.
 */

let replSet: MongoMemoryReplSet;

const adapters = {
  db: {
    organizations: organizationRepository,
    groups: groupRepository,
    users: userRepository,
  },
};

beforeAll(async () => {
  replSet = await createMongoReplSet();
  await mongoose.connect(replSet.getUri());
}, 60000);
afterAll(async () => {
  await mongoose.disconnect();
  await replSet?.stop();
}, 60000);
afterEach(async () => {
  await mongoose.connection.dropDatabase();
});

const rawOrg = (id: string) => Organization.collection.findOne({ _id: new mongoose.Types.ObjectId(id) });
const rawGroup = (id: string) => Group.collection.findOne({ _id: new mongoose.Types.ObjectId(id) });

const seed = async () => {
  const owner = await User.create({
    name: 'Owner',
    username: `owner-${Math.random().toString(36).slice(2, 10)}`,
    password: null,
    hasUsablePassword: false,
  });
  const org = await Organization.create({ name: 'Acme', userId: owner.id, users: [] });
  const group = await Group.create({
    name: 'Sales',
    description: 'd',
    type: 'sales',
    organizationId: String(org._id),
  });
  const member = await User.create({
    name: 'Member',
    username: `member-${Math.random().toString(36).slice(2, 10)}`,
    password: null,
    hasUsablePassword: false,
    groups: [String(group._id)],
  });
  return { owner, orgId: String(org._id), groupId: String(group._id), memberId: member.id };
};

describe('deleteOrganization - transaction participation (replica set)', () => {
  it('rolls the org soft-delete back with the rest when the transaction aborts', async () => {
    const { owner, orgId, groupId, memberId } = await seed();

    // Fail AFTER deleteOrganization returns but still inside the transaction - the deterministic
    // stand-in for a commit-time transient error or a process death in that window.
    await expect(
      withTransaction(async () => {
        await organizationService.deleteOrganization(owner as any, { id: orgId }, adapters as any);
        throw new Error('post-delete failure');
      })
    ).rejects.toThrow('post-delete failure');

    // All three writes must be absent. Before the fix the org row alone carried deletedAt, because
    // the raw-driver soft-delete had already committed outside the session.
    expect((await rawOrg(orgId))?.deletedAt ?? null).toBeNull();
    expect((await rawGroup(groupId))?.deletedAt ?? null).toBeNull();
    expect((await User.findById(memberId))?.groups).toEqual([groupId]);
  });

  it('commits the org soft-delete, the group soft-delete and the member purge together', async () => {
    const { owner, orgId, groupId, memberId } = await seed();

    await withTransaction(() => organizationService.deleteOrganization(owner as any, { id: orgId }, adapters as any));

    expect((await rawOrg(orgId))?.deletedAt).toBeInstanceOf(Date);
    expect((await rawGroup(groupId))?.deletedAt).toBeInstanceOf(Date);
    expect((await User.findById(memberId))?.groups).toEqual([]);
  });
});
