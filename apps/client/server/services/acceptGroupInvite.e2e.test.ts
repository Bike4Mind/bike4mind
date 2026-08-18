import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { InviteType } from '@bike4mind/common';
import { BadRequestError } from '@bike4mind/utils';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import { createMongoServer } from '../../../../packages/database/src/__test__/createMongoServer';
import {
  Group,
  Organization,
  Invite,
  User,
  inviteRepository,
  userRepository,
  fabFileRepository,
  sessionRepository,
  projectRepository,
} from '@bike4mind/database';
import { sharingService } from '@bike4mind/services';

/**
 * End-to-end guard for #1224: driving the REAL sharingService.acceptInvite through the REAL
 * repositories against createMongoServer, matching the sibling groupInviteAuth.e2e.test.ts (which
 * exists because a prior mock-only unit test hid a runtime bug in this same group -> org
 * resolution path). Consumes the built dist, so `pnpm turbo:core:build` must be current.
 */

let mongoServer: MongoMemoryServer;

const db = {
  invites: inviteRepository,
  sessions: sessionRepository,
  projects: projectRepository,
  fabFiles: fabFileRepository,
  groups: { findById: (id: string) => Group.findById(id) },
  organization: Organization,
  users: userRepository,
};

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
}, 30000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
}, 30000);
afterEach(async () => {
  await mongoose.connection.dropDatabase();
});

const seedGroupInvite = async (memberIds: string[] = []) => {
  const org = await Organization.create({
    name: 'Org',
    userId: 'owner-1',
    users: memberIds.map(userId => ({ userId, permissions: ['read'] })),
  });
  const group = await Group.create({ name: 'Sales', description: 'd', type: 'sales', organizationId: String(org._id) });
  const invite = await Invite.create({
    type: InviteType.Group,
    documentId: String(group._id),
    remaining: 2,
    recipients: { pending: ['a@x.com', 'b@x.com'], accepted: [], refused: [] },
  });
  return { orgId: String(org._id), groupId: String(group._id), inviteId: String(invite._id) };
};

describe('sharingService.acceptInvite (Group) - end-to-end, real repos + Mongo', () => {
  it('adds the group id to user.groups for a real org member', async () => {
    const user = await User.create({
      name: 'Member',
      username: 'member1',
      email: 'a@x.com',
      password: null,
      hasUsablePassword: false,
    });
    const { groupId, inviteId } = await seedGroupInvite([user.id]);

    await sharingService.acceptInvite(user.id, { id: inviteId }, { db } as any);

    const reloaded = await User.findById(user.id);
    expect(reloaded?.groups).toEqual([groupId]);
  });

  it('rejects a real user who is not a member of the group organization', async () => {
    const user = await User.create({
      name: 'Outsider',
      username: 'outsider1',
      email: 'b@x.com',
      password: null,
      hasUsablePassword: false,
    });
    // seed the org with a DIFFERENT member - this user is not in it
    const { inviteId } = await seedGroupInvite(['someone-else']);

    await expect(sharingService.acceptInvite(user.id, { id: inviteId }, { db } as any)).rejects.toThrow(
      BadRequestError
    );

    const reloaded = await User.findById(user.id);
    expect(reloaded?.groups ?? []).toEqual([]);
  });

  it('fails closed for a soft-deleted (revoked) group', async () => {
    const user = await User.create({
      name: 'Member',
      username: 'member2',
      email: 'a@x.com',
      password: null,
      hasUsablePassword: false,
    });
    const { groupId, inviteId } = await seedGroupInvite([user.id]);
    await Group.updateOne({ _id: groupId }, { $set: { deletedAt: new Date() } });

    await expect(sharingService.acceptInvite(user.id, { id: inviteId }, { db } as any)).rejects.toThrow(/not found/i);

    const reloaded = await User.findById(user.id);
    expect(reloaded?.groups ?? []).toEqual([]);
  });
});
