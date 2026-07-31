import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { InviteType, Permission } from '@bike4mind/common';
import { BadRequestError } from '@bike4mind/utils';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import { createMongoServer } from '../../../../packages/database/src/__test__/createMongoServer';
import { Project, inviteRepository, projectRepository, userRepository } from '@bike4mind/database';
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
  // The real repository, not a stub: the adapter also declares `findById`, and a stub plus the
  // `{ db } as any` cast below would let a future read of it fail at runtime instead of compile time.
  users: userRepository,
  projects: projectRepository,
};

// `groups: []` matters - findShareAccessById's third arm reads user.groups, so omitting it leaves
// that arm structurally unreachable from these fixtures.
const ownerUser = { id: 'owner-1', username: 'owner', groups: [], isAdmin: false } as any;
const shareMemberUser = { id: 'share-member-1', username: 'sharer', groups: [], isAdmin: false } as any;
const updateOnlyMemberUser = { id: 'update-only-1', username: 'updater', groups: [], isAdmin: false } as any;
const outsiderUser = { id: 'outsider-1', username: 'outsider', groups: [], isAdmin: false } as any;

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

    // Capture both rejections and compare them: asserting only a class for one and only a message
    // for the other would let `BadRequestError('No share access to <name>')` keep this green while
    // reintroducing the existence oracle the test is named for.
    const denied = await createProjectInvite(outsiderUser, String(project._id)).catch((e: Error) => e);
    const missing = await createProjectInvite(outsiderUser, '507f1f77bcf86cd799439011').catch((e: Error) => e);

    expect(denied).toBeInstanceOf(BadRequestError);
    expect(missing).toBeInstanceOf(BadRequestError);
    expect(denied.message).toBe(missing.message);
    expect(denied.message).not.toContain(PROJECT_NAME);
    // errorHandler spreads `additionalInfo` verbatim into the response body, so it is a second
    // channel the message assertions above do not cover.
    expect((denied as BadRequestError).additionalInfo).toEqual((missing as BadRequestError).additionalInfo);

    expect(await inviteRepository.findAllByDocumentId(String(project._id))).toHaveLength(0);
  });

  it('lets a collaborator whose share grant comes from a group create a project invite', async () => {
    // The third arm of findShareAccessById (groups[].share) is otherwise unexercised on this path.
    const project = await Project.create({
      name: PROJECT_NAME,
      description: 'd',
      userId: ownerUser.id,
      sessionIds: [],
      fileIds: [],
      groups: [{ groupId: 'grp-1', permissions: [Permission.share] }],
    });

    const invite = await createProjectInvite({ ...outsiderUser, groups: ['grp-1'] }, String(project._id));

    expect(invite.name).toBe(PROJECT_NAME);
  });
});
