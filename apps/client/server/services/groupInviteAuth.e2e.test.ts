import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { InviteType } from '@bike4mind/common';
import { UnauthorizedError } from '@bike4mind/utils';
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

const db = {
  fabFiles: fabFileRepository,
  sessions: sessionRepository,
  projects: projectRepository,
  organizations: organizationRepository,
  groups: { findById: (id: string) => Group.findById(id) },
  invites: inviteRepository,
};

const memberUser = { id: 'member-1', groups: [], isAdmin: false } as any;
const strangerUser = { id: 'stranger-1', groups: [], isAdmin: false } as any;

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
  const group = await Group.create({ name: 'G', description: 'd', organizationId: String(org._id) });
  const invite = await Invite.create({
    type: InviteType.Group,
    documentId: String(group._id),
    remaining: 1,
    recipients: { pending: ['x@y.com'], accepted: [], refused: [] },
  });
  return { groupId: String(group._id), inviteId: String(invite._id) };
};

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
