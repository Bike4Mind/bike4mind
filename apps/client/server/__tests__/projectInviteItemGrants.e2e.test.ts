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

  /**
   * A project whose member holds [read, share] on it, with one attached item of each kind per case:
   * `shared` items carry the member's project-tagged [read, share] row, `readOnly` items a read row,
   * `unheld` items no row for the member at all.
   */
  const seed = async () => {
    const owner = await makeUser('owner');
    const member = await makeUser('member');
    const accepter = await makeUser('accepter');
    const projectId = new mongoose.Types.ObjectId().toString();
    const viaProject = (permissions: Permission[]): Share[] => [{ userId: member.id, permissions, projectId }];

    const files = {
      shared: await makeFile(owner.id, 'shared.txt', viaProject(memberGrant)),
      readOnly: await makeFile(owner.id, 'read-only.txt', viaProject([Permission.read])),
      unheld: await makeFile(owner.id, 'unheld.txt'),
      ownedByMember: await makeFile(member.id, 'mine.txt'),
    };
    const prompts = {
      shared: await makeFile(owner.id, 'prompt-shared.txt', viaProject(memberGrant)),
      unheld: await makeFile(owner.id, 'prompt-unheld.txt'),
    };
    const sessions = {
      shared: await makeSession(owner.id, 'shared', viaProject(memberGrant)),
      unheld: await makeSession(owner.id, 'unheld'),
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

    const mint = async (inviterId: string) =>
      String(
        (
          await Invite.create({
            type: InviteType.Project,
            documentId: projectId,
            inviterId,
            isLinkOnly: true,
            permissions: memberGrant,
            remaining: 1,
          })
        )._id
      );

    return { owner, member, accepter, projectId, files, prompts, sessions, mint };
  };

  it('grants only the items the minting member can share, capped to what they hold on each', async () => {
    const { member, accepter, projectId, files, prompts, sessions, mint } = await seed();

    await accept(accepter.id, await mint(member.id));

    const granted = [{ permissions: memberGrant, projectId }];
    expect(rowsFor(await Project.findById(projectId).lean<{ users: Share[] }>(), accepter.id)).toEqual([
      { permissions: memberGrant, projectId: undefined },
    ]);
    expect(await fileRows(files.shared, accepter.id)).toEqual(granted);
    expect(await fileRows(files.ownedByMember, accepter.id)).toEqual(granted);
    expect(await fileRows(files.readOnly, accepter.id)).toEqual([]);
    expect(await fileRows(files.unheld, accepter.id)).toEqual([]);
    expect(await fileRows(prompts.shared, accepter.id)).toEqual(granted);
    expect(await fileRows(prompts.unheld, accepter.id)).toEqual([]);
    expect(await sessionRows(sessions.shared, accepter.id)).toEqual(granted);
    expect(await sessionRows(sessions.unheld, accepter.id)).toEqual([]);
  });

  it('grants every attached item at the invite permissions when the project owner minted it', async () => {
    const { owner, accepter, projectId, files, prompts, sessions, mint } = await seed();

    await accept(accepter.id, await mint(owner.id));

    const granted = [{ permissions: memberGrant, projectId }];
    for (const id of [...Object.values(files), ...Object.values(prompts)]) {
      expect(await fileRows(id, accepter.id)).toEqual(granted);
    }
    for (const id of Object.values(sessions)) expect(await sessionRows(id, accepter.id)).toEqual(granted);
  });
});
