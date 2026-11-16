import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import {
  FabFile,
  Invite,
  Project,
  Session,
  User,
  fabFileRepository,
  inviteRepository,
  projectRepository,
  sessionRepository,
  userRepository,
} from '@bike4mind/database';
import { sharingService } from '@bike4mind/services';
import { InviteType, KnowledgeType, Permission } from '@bike4mind/common';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});
afterEach(async () => {
  await Promise.all([
    Project.deleteMany({}, { hardDelete: true }),
    FabFile.deleteMany({}, { hardDelete: true }),
    Session.deleteMany({}, { hardDelete: true }),
    User.deleteMany({}),
    Invite.deleteMany({}),
  ]);
});

const makeUser = async (name: string) => {
  const email = `${name}@example.com`;
  const user = await User.create({
    name,
    username: `${name}-${new mongoose.Types.ObjectId().toString()}`,
    email,
    password: null,
    hasUsablePassword: false,
  });
  return { id: String(user._id), email };
};

type Share = { userId: string; permissions: Permission[]; projectId?: string };

const makeFile = async (userId: string, fileName: string, users: Share[] = []) =>
  String((await FabFile.create({ userId, fileName, type: KnowledgeType.FILE, users }))._id);

const makeSession = async (userId: string, name: string, users: Share[] = []) =>
  String((await Session.create({ userId, name, users, firstCreated: new Date(), lastUpdated: new Date() }))._id);

const rowsFor = (doc: { users?: Share[] } | null, userId: string) =>
  (doc?.users ?? [])
    .filter(row => row.userId === userId)
    .map(({ permissions, projectId }) => ({ permissions, projectId }));

const fileRows = async (id: string, userId: string) =>
  rowsFor(await FabFile.findById(id).lean<{ users: Share[] }>(), userId);
const sessionRows = async (id: string, userId: string) =>
  rowsFor(await Session.findById(id).lean<{ users: Share[] }>(), userId);

const accept = (accepterId: string, inviteId: string) =>
  sharingService.acceptInvite(accepterId, { id: inviteId }, {
    db: {
      invites: inviteRepository,
      sessions: sessionRepository,
      projects: projectRepository,
      fabFiles: fabFileRepository,
      groups: { findById: async () => null },
      organization: {
        findById: async () => null,
        addMemberIfUnderCeiling: async () => null,
        ensureUserDetails: async () => undefined,
      },
      users: userRepository,
      spaces: { findLiveById: async () => null, addMember: async () => null },
    },
    limits: { spaceMaxMembers: 0, spacesEnabled: false },
  } as never);

describe('Project invite accept: grants on attached files, prompts and notebooks', () => {
  const memberGrant = [Permission.read, Permission.share];
  const readOnly = [Permission.read];

  /**
   * A project whose member holds [read, share] on it. `shared` items carry project-tagged rows that
   * give the member [read, share]; `readOnly` items give the owner and the member read; `unheld` items
   * belong to a third user and carry no row for either; `ownedByMember` is the member's own file, on
   * which the owner holds [read, update], as when a member attaches it.
   */
  const seed = async () => {
    const owner = await makeUser('owner');
    const member = await makeUser('member');
    const outsider = await makeUser('outsider');
    const accepter = await makeUser('accepter');
    const projectId = new mongoose.Types.ObjectId().toString();
    const tagged = (userId: string, permissions: Permission[]): Share => ({ userId, permissions, projectId });

    const files = {
      shared: await makeFile(owner.id, 'shared.txt', [tagged(member.id, memberGrant)]),
      readOnly: await makeFile(outsider.id, 'read-only.txt', [tagged(owner.id, readOnly), tagged(member.id, readOnly)]),
      unheld: await makeFile(outsider.id, 'unheld.txt'),
      ownedByMember: await makeFile(member.id, 'mine.txt', [tagged(owner.id, [Permission.read, Permission.update])]),
    };
    const prompts = {
      shared: await makeFile(owner.id, 'prompt-shared.txt', [tagged(member.id, memberGrant)]),
      unheld: await makeFile(outsider.id, 'prompt-unheld.txt'),
    };
    const sessions = {
      shared: await makeSession(owner.id, 'shared', [tagged(member.id, memberGrant)]),
      unheld: await makeSession(outsider.id, 'unheld'),
    };

    await Project.create({
      _id: projectId,
      name: 'P',
      description: 'd',
      userId: owner.id,
      fileIds: Object.values(files),
      systemPrompts: Object.values(prompts).map(fileId => ({ fileId, enabled: true })),
      sessionIds: Object.values(sessions),
      users: [{ userId: member.id, permissions: memberGrant }],
    });

    const mint = async (inviterId?: string) =>
      String(
        (
          await Invite.create({
            type: InviteType.Project,
            documentId: projectId,
            ...(inviterId ? { inviterId } : {}),
            isLinkOnly: true,
            permissions: memberGrant,
            remaining: 1,
          })
        )._id
      );

    return { owner, member, accepter, projectId, files, prompts, sessions, mint };
  };

  const projectRows = async (projectId: string, userId: string) =>
    rowsFor(await Project.findById(projectId).lean<{ users: Share[] }>(), userId);

  it('caps a member-minted invite on each item to what the member holds there', async () => {
    const { member, accepter, projectId, files, prompts, sessions, mint } = await seed();

    await accept(accepter.id, await mint(member.id));

    const full = [{ permissions: memberGrant, projectId }];
    expect(await projectRows(projectId, accepter.id)).toEqual([{ permissions: memberGrant, projectId: undefined }]);
    expect(await fileRows(files.shared, accepter.id)).toEqual(full);
    expect(await fileRows(files.ownedByMember, accepter.id)).toEqual(full);
    expect(await fileRows(files.readOnly, accepter.id)).toEqual([{ permissions: readOnly, projectId }]);
    expect(await fileRows(files.unheld, accepter.id)).toEqual([]);
    expect(await fileRows(prompts.shared, accepter.id)).toEqual(full);
    expect(await fileRows(prompts.unheld, accepter.id)).toEqual([]);
    expect(await sessionRows(sessions.shared, accepter.id)).toEqual(full);
    expect(await sessionRows(sessions.unheld, accepter.id)).toEqual([]);
  });

  it('caps an owner-minted invite on each item to what the owner holds there', async () => {
    const { owner, accepter, projectId, files, prompts, sessions, mint } = await seed();

    await accept(accepter.id, await mint(owner.id));

    const full = [{ permissions: memberGrant, projectId }];
    expect(await projectRows(projectId, accepter.id)).toEqual([{ permissions: memberGrant, projectId: undefined }]);
    expect(await fileRows(files.shared, accepter.id)).toEqual(full);
    expect(await fileRows(files.ownedByMember, accepter.id)).toEqual([{ permissions: readOnly, projectId }]);
    expect(await fileRows(files.readOnly, accepter.id)).toEqual([{ permissions: readOnly, projectId }]);
    expect(await fileRows(files.unheld, accepter.id)).toEqual([]);
    expect(await fileRows(prompts.shared, accepter.id)).toEqual(full);
    expect(await fileRows(prompts.unheld, accepter.id)).toEqual([]);
    expect(await sessionRows(sessions.shared, accepter.id)).toEqual(full);
    expect(await sessionRows(sessions.unheld, accepter.id)).toEqual([]);
  });

  it('grants every attached item at the invite permissions when the invite records no inviter', async () => {
    const { accepter, projectId, files, prompts, sessions, mint } = await seed();

    await accept(accepter.id, await mint());

    const full = [{ permissions: memberGrant, projectId }];
    for (const id of [...Object.values(files), ...Object.values(prompts)]) {
      expect(await fileRows(id, accepter.id)).toEqual(full);
    }
    for (const id of Object.values(sessions)) expect(await sessionRows(id, accepter.id)).toEqual(full);
  });
});
