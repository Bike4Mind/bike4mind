import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { InviteType, Permission } from '@bike4mind/common';
import { BadRequestError } from '@bike4mind/utils';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import { createMongoServer } from '../../../../packages/database/src/__test__/createMongoServer';
import { Project, inviteRepository, projectRepository } from '@bike4mind/database';
import { sharingService } from '@bike4mind/services';

/**
 * End-to-end guard for the project-scoped invite auth path, driving the REAL
 * sharingService.createInvite through the REAL projectRepository against createMongoServer.
 * Previously this arm called db.projects.findById unscoped, so any authenticated caller who knew a
 * project id could mint an invite for it; it now goes through shareable.findShareAccessById,
 * matching the FabFile arm. Consumes the built dist, so `pnpm turbo:core:build` must be current.
 */

let mongoServer: MongoMemoryServer;

const db = {
  invites: inviteRepository,
  users: { findAllByEmailsOrUsernames: async () => [] },
  projects: projectRepository,
};

const ownerUser = { id: 'owner-1', username: 'owner', isAdmin: false } as any;
const shareMemberUser = { id: 'share-member-1', username: 'sharer', isAdmin: false } as any;
const updateOnlyMemberUser = { id: 'update-only-1', username: 'updater', isAdmin: false } as any;
const outsiderUser = { id: 'outsider-1', username: 'outsider', isAdmin: false } as any;

const PROJECT_NAME = 'Confidential Project';

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

// Seeds a project owned by ownerUser, with a share-permission collaborator and an
// update-only collaborator (no share).
const seedProject = async () =>
  Project.create({
    name: PROJECT_NAME,
    description: 'd',
    userId: ownerUser.id,
    sessionIds: [],
    fileIds: [],
    users: [
      { userId: shareMemberUser.id, permissions: [Permission.share] },
      { userId: updateOnlyMemberUser.id, permissions: [Permission.update] },
    ],
  });

const createProjectInvite = (user: unknown, projectId: string) =>
  sharingService.createInvite(
    user as any,
    { id: projectId, type: InviteType.Project, permissions: [Permission.read], recipients: ['x@y.com'] } as any,
    { db } as any
  );

describe('project-invite authorization (end-to-end, real repos + Mongo)', () => {
  it('lets the owner create a project invite', async () => {
    const project = await seedProject();

    const invite = await createProjectInvite(ownerUser, String(project._id));

    expect(invite.type).toBe(InviteType.Project);
    expect(invite.name).toBe(PROJECT_NAME);
  });

  it('lets a collaborator with share permission create a project invite', async () => {
    const project = await seedProject();

    const invite = await createProjectInvite(shareMemberUser, String(project._id));

    expect(invite.name).toBe(PROJECT_NAME);
  });

  it('rejects a collaborator who holds update but not share permission', async () => {
    const project = await seedProject();

    await expect(createProjectInvite(updateOnlyMemberUser, String(project._id))).rejects.toThrow(BadRequestError);
    expect(await inviteRepository.findAllByDocumentId(String(project._id))).toHaveLength(0);
  });

  it('rejects a caller with no relationship to the project, indistinguishably from a missing one', async () => {
    const project = await seedProject();

    await expect(createProjectInvite(outsiderUser, String(project._id))).rejects.toThrow(BadRequestError);
    await expect(createProjectInvite(outsiderUser, '507f1f77bcf86cd799439011')).rejects.toThrow('Document not found');
    expect(await inviteRepository.findAllByDocumentId(String(project._id))).toHaveLength(0);
  });
});
