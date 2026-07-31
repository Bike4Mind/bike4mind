import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { InviteType, Permission } from '@bike4mind/common';
import { ForbiddenError, UnauthorizedError } from '@bike4mind/utils';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import { createMongoServer } from '../../../../packages/database/src/__test__/createMongoServer';
import {
  Group,
  Organization,
  Invite,
  inviteRepository,
  organizationRepository,
  fabFileRepository,
  sessionRepository,
  projectRepository,
  userRepository,
} from '@bike4mind/database';
import { sharingService } from '@bike4mind/services';

/**
 * End-to-end guard for the group-scoped invite auth path, driving the REAL
 * sharingService functions through the REAL repositories against createMongoServer.
 * The prior mock-only unit test hid a runtime bug (Group.organizationId was never
 * persisted), so this test persists a real Group + Organization share grant and proves
 * the wired path resolves. It also pins the legacy-group case (a group with no
 * organizationId - i.e. pre-fix data) as fail-closed. Consumes the built dist, so
 * `pnpm turbo:core:build` must be current.
 */

let mongoServer: MongoMemoryServer;

const GROUP_NAME = 'Confidential Group';

const db = {
  fabFiles: fabFileRepository,
  sessions: sessionRepository,
  projects: projectRepository,
  organizations: organizationRepository,
  groups: { findById: (id: string) => Group.findById(id) },
  invites: inviteRepository,
  users: userRepository,
};

const memberUser = { id: 'member-1', groups: [], isAdmin: false } as any;
const strangerUser = { id: 'stranger-1', groups: [], isAdmin: false } as any;
const ownerUser = { id: 'owner-1', username: 'owner', groups: [], isAdmin: false } as any;
const platformAdminUser = { id: 'platform-1', username: 'padmin', groups: [], isAdmin: true } as any;

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

// Seeds an org with a users[]-share grant for memberUser, a group under it, and a
// pending Group invite on that group. Returns the group + invite ids.
const seedGroupInvite = async () => {
  const org = await Organization.create({
    name: 'Org',
    userId: 'owner-1',
    users: [{ userId: memberUser.id, permissions: ['share'] }],
  });
  const group = await Group.create({ name: 'G', description: 'd', type: 'sales', organizationId: String(org._id) });
  const invite = await Invite.create({
    type: InviteType.Group,
    documentId: String(group._id),
    remaining: 1,
    recipients: { pending: ['x@y.com'], accepted: [], refused: [] },
  });
  return { groupId: String(group._id), inviteId: String(invite._id) };
};

// Same org + group shape, but no pre-existing invite: the create path mints its own.
const seedOrgAndGroup = async () => {
  const org = await Organization.create({
    name: 'Org',
    userId: ownerUser.id,
    users: [{ userId: memberUser.id, permissions: ['share'] }],
  });
  const group = await Group.create({
    name: GROUP_NAME,
    description: 'd',
    type: 'sales',
    organizationId: String(org._id),
  });
  return { groupId: String(group._id), orgId: String(org._id) };
};

const createGroupInvite = (user: unknown, groupId: string) =>
  sharingService.createInvite(
    user as any,
    { id: groupId, type: InviteType.Group, permissions: [Permission.read], recipients: ['x@y.com'] } as any,
    { db } as any
  );

describe('group-invite authorization (end-to-end, real repos + Mongo)', () => {
  it('lists group invites for a caller with an org share grant', async () => {
    const { groupId } = await seedGroupInvite();

    const result = await sharingService.listInvitesForDocument(
      memberUser,
      { documentId: groupId, type: InviteType.Group },
      { db } as any
    );

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe(InviteType.Group);
  });

  it('denies a caller with no org share grant', async () => {
    const { groupId } = await seedGroupInvite();

    await expect(
      sharingService.listInvitesForDocument(strangerUser, { documentId: groupId, type: InviteType.Group }, {
        db,
      } as any)
    ).rejects.toThrow(UnauthorizedError);
  });

  it('cancels a group invite for an authorized caller (remaining -> 0)', async () => {
    const { inviteId } = await seedGroupInvite();

    await sharingService.cancelInviteById(memberUser, { id: inviteId }, { db } as any);

    const reloaded = await Invite.findById(inviteId);
    expect(reloaded?.remaining).toBe(0);
  });

  it('lets the billing owner create a group invite', async () => {
    const { groupId } = await seedOrgAndGroup();

    const invite = await createGroupInvite(ownerUser, groupId);

    expect(invite.type).toBe(InviteType.Group);
    expect(invite.name).toBe(GROUP_NAME);
    expect(await Invite.countDocuments({ documentId: groupId })).toBe(1);
  });

  it('lets a platform admin create a group invite', async () => {
    const { groupId } = await seedOrgAndGroup();

    const invite = await createGroupInvite(platformAdminUser, groupId);

    expect(invite.name).toBe(GROUP_NAME);
  });

  it('rejects a group invite created by a member holding only an org share grant', async () => {
    // memberUser has permissions: ['share'], which is enough to LIST invites (first test above)
    // but not to mint one - creating a group invite is a membership grant, not a share action.
    const { groupId } = await seedOrgAndGroup();

    await expect(createGroupInvite(memberUser, groupId)).rejects.toThrow(ForbiddenError);
    expect(await Invite.countDocuments({ documentId: groupId })).toBe(0);
  });

  it('rejects a group invite created from outside the organization and discloses no group name', async () => {
    const { groupId } = await seedOrgAndGroup();

    await expect(createGroupInvite(strangerUser, groupId)).rejects.toSatisfy(
      (e: Error) => !e.message.includes(GROUP_NAME)
    );
    expect(await Invite.countDocuments({ documentId: groupId })).toBe(0);
  });

  it('fails closed for a legacy group with no organizationId (pre-fix data)', async () => {
    // Insert a raw group doc missing organizationId, bypassing schema validation, to
    // simulate a group created before the schema carried the field. The auth arm then
    // resolves organizationId=undefined and must deny (not throw a 500 or allow).
    const legacy = await mongoose.connection
      .collection('groups')
      .insertOne({ name: 'Legacy', description: 'd', createdAt: new Date(), updatedAt: new Date() });
    const legacyGroupId = String(legacy.insertedId);
    await Invite.create({
      type: InviteType.Group,
      documentId: legacyGroupId,
      remaining: 1,
      recipients: { pending: ['x@y.com'], accepted: [], refused: [] },
    });

    await expect(
      sharingService.listInvitesForDocument(memberUser, { documentId: legacyGroupId, type: InviteType.Group }, {
        db,
      } as any)
    ).rejects.toThrow(UnauthorizedError);
  });
});
