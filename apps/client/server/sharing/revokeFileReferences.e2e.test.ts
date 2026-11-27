import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
// createMongoReplSet is not exported from the package barrel / dist; deep-import the source.
import {
  createMongoReplSet,
  MONGO_TEST_TIMEOUT_MS,
  settleAutoIndexBuilds,
} from '../../../../packages/database/src/__test__/createMongoServer';
import {
  FabFile,
  fabFileRepository,
  Project,
  projectRepository,
  Session,
  sessionRepository,
  User,
  userRepository,
  organizationRepository,
  withTransaction,
} from '@bike4mind/database';
import { projectService, sessionService, sharingService } from '@bike4mind/services';
import { Logger } from '@bike4mind/observability';
import { cleanUpRevokedFileReferences, projectRevokeCleanupTargets } from './revokedFileReferences';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

/**
 * An owner revoking a share left the file in the recipient's system files and sessions. The turn-time
 * scrub keeps a live file the caller cannot read, so the reference warned on every turn for good.
 * Drives the REAL revoke (in a transaction, as the route does) and cleanup against a replica set.
 * Needs the built services dist: `pnpm turbo:core:build`.
 */

const logger = Logger.globalInstance;
const db = { users: userRepository, fabFiles: fabFileRepository, sessions: sessionRepository };

let replSet: Awaited<ReturnType<typeof createMongoReplSet>> | undefined;

beforeAll(async () => {
  replSet = await createMongoReplSet();
  await mongoose.connect(replSet.getUri(), { autoIndex: false });
  await settleAutoIndexBuilds(mongoose);
});
afterAll(async () => {
  await mongoose.disconnect();
  await replSet?.stop();
});
afterEach(async () => {
  await Promise.all([
    FabFile.collection.deleteMany({}),
    Project.collection.deleteMany({}),
    Session.collection.deleteMany({}),
    User.collection.deleteMany({}),
  ]);
});

const oid = () => new mongoose.Types.ObjectId();

const seedUser = async (fileId?: mongoose.Types.ObjectId, groups: string[] = []) => {
  const _id = oid();
  await User.collection.insertOne({
    _id,
    username: `u-${_id}`,
    name: 'fixture',
    email: `${_id}@example.com`,
    groups,
    systemFiles: fileId ? [{ fileId: String(fileId), enabled: true }] : [],
  });
  if (fileId) {
    await Session.collection.insertOne({
      _id: oid(),
      userId: String(_id),
      knowledgeIds: [String(fileId)],
      deletedAt: null,
    });
  }
  return String(_id);
};

const seedFile = async (fileId: mongoose.Types.ObjectId, ownerId: string, extra: Record<string, unknown> = {}) =>
  FabFile.collection.insertOne({
    _id: fileId,
    userId: ownerId,
    fileName: 'notes.pdf',
    mimeType: 'application/pdf',
    users: [],
    groups: [],
    isGlobalRead: false,
    deletedAt: null,
    archivedAt: null,
    __v: 0,
    ...extra,
  });

const share = (userId: string) => ({ userId, permissions: ['read', 'write'] });

const revokeAndCleanUp = async (ownerId: string, fileId: string, recipientId: string) => {
  await withTransaction(() =>
    sharingService.revoke(
      ownerId,
      { id: fileId, type: 'files', userId: recipientId },
      { db: { ...db, projects: projectRepository } as never }
    )
  );
  await cleanUpRevokedFileReferences([{ userId: recipientId, fileIds: [fileId] }], logger);
};

const systemFileIds = async (userId: string) =>
  ((await User.collection.findOne({ _id: new mongoose.Types.ObjectId(userId) }))?.systemFiles ?? []).map(
    (f: { fileId: string }) => f.fileId
  );
const sessionKnowledgeIds = async (userId: string) =>
  ((await Session.collection.findOne({ userId }))?.knowledgeIds ?? []) as string[];

describe('revoking a file share cleans up the recipient references', () => {
  it('without cleanup the revoked file stays pinned and the turn-time scrub never removes it', async () => {
    const fileId = oid();
    const ownerId = await seedUser(fileId);
    const recipientId = await seedUser(fileId);
    await seedFile(fileId, ownerId, { users: [share(recipientId)] });

    await withTransaction(() =>
      sharingService.revoke(
        ownerId,
        { id: String(fileId), type: 'files', userId: recipientId },
        { db: { ...db, projects: projectRepository } as never }
      )
    );
    // What the turn reports for a pinned file it could not load.
    const notices = [
      {
        fabFileId: String(fileId),
        fileName: String(fileId),
        band: 'unresolved' as const,
        message: '',
        delivered: false,
      },
    ];
    const removed = await sessionService.scrubStaleSystemFiles(recipientId, [String(fileId)], notices, {
      db: { fabFiles: fabFileRepository, users: userRepository },
    });

    expect(removed).toEqual([]);
    expect(await systemFileIds(recipientId)).toEqual([String(fileId)]);
  });

  it("drops the file from the recipient's system files and sessions, and only theirs", async () => {
    const fileId = oid();
    const ownerId = await seedUser(fileId);
    const recipientId = await seedUser(fileId);
    await seedFile(fileId, ownerId, { users: [share(recipientId)] });

    await revokeAndCleanUp(ownerId, String(fileId), recipientId);

    expect(await systemFileIds(recipientId)).toEqual([]);
    expect(await sessionKnowledgeIds(recipientId)).toEqual([]);
    expect(await systemFileIds(ownerId)).toEqual([String(fileId)]);
    expect(await sessionKnowledgeIds(ownerId)).toEqual([String(fileId)]);
  });

  it('keeps the references when the file is still globally readable', async () => {
    const fileId = oid();
    const ownerId = await seedUser();
    const recipientId = await seedUser(fileId);
    await seedFile(fileId, ownerId, { users: [share(recipientId)], isGlobalRead: true });

    await revokeAndCleanUp(ownerId, String(fileId), recipientId);

    expect(await systemFileIds(recipientId)).toEqual([String(fileId)]);
    expect(await sessionKnowledgeIds(recipientId)).toEqual([String(fileId)]);
  });

  it("keeps the references when the file is still shared with the recipient's group", async () => {
    const fileId = oid();
    const groupId = String(oid());
    const ownerId = await seedUser();
    const recipientId = await seedUser(fileId, [groupId]);
    await seedFile(fileId, ownerId, {
      users: [share(recipientId)],
      groups: [{ groupId, permissions: ['read'] }],
    });

    await revokeAndCleanUp(ownerId, String(fileId), recipientId);

    expect(await systemFileIds(recipientId)).toEqual([String(fileId)]);
  });
});

describe('session revoke and project delete clean up the references they strand', () => {
  it("an unscoped session revoke drops the session's files from the recipient's pins", async () => {
    const fileId = oid();
    const sessionId = oid();
    const ownerId = await seedUser();
    const recipientId = await seedUser(fileId);
    // accept.ts tags the file grant a session share mints with that session's id.
    await seedFile(fileId, ownerId, {
      users: [{ ...share(recipientId), sessionId: String(sessionId) }],
    });
    await Session.collection.insertOne({
      _id: sessionId,
      userId: ownerId,
      name: 'shared notebook',
      knowledgeIds: [String(fileId)],
      users: [share(recipientId)],
      groups: [],
      deletedAt: null,
      __v: 0,
    });

    const session = await withTransaction(() =>
      sharingService.revoke(
        ownerId,
        { id: String(sessionId), type: 'sessions', userId: recipientId },
        { db: { ...db, projects: projectRepository } as never }
      )
    );
    await cleanUpRevokedFileReferences(
      [{ userId: recipientId, fileIds: (session as { knowledgeIds?: string[] }).knowledgeIds ?? [] }],
      logger
    );

    expect(await systemFileIds(recipientId)).toEqual([]);
  });

  it("deleting a project drops its files from every member's pins", async () => {
    const fileId = oid();
    const ownerId = await seedUser();
    const memberId = await seedUser(fileId);
    const projectId = oid();
    await seedFile(fileId, ownerId, {
      users: [{ ...share(memberId), projectId: String(projectId) }],
    });
    await Project.collection.insertOne({
      _id: projectId,
      name: 'p',
      description: 'd',
      userId: ownerId,
      users: [{ userId: memberId, permissions: ['read', 'update'] }],
      fileIds: [String(fileId)],
      sessionIds: [],
      deletedAt: null,
      __v: 0,
    });

    const targets = await projectRevokeCleanupTargets(String(projectId), undefined, logger);
    await projectService.deleteProject(
      ownerId,
      { id: String(projectId) },
      { db: { ...db, projects: projectRepository } as never }
    );
    await cleanUpRevokedFileReferences(targets, logger);

    expect(await systemFileIds(memberId)).toEqual([]);
  });
});

const sharingDb = { ...db, projects: projectRepository };
const projectRow = (userId: string, permissions: string[] = ['read', 'share']) => ({ userId, permissions });
const seedProject = async (
  userId: string,
  users: ReturnType<typeof projectRow>[],
  extra: Record<string, unknown> = {}
) => {
  const id = oid();
  await Project.collection.insertOne({
    _id: id,
    name: `Project ${id}`,
    description: '',
    userId,
    users,
    groups: [],
    fileIds: [],
    sessionIds: [],
    systemPrompts: [],
    deletedAt: null,
    __v: 0,
    ...extra,
  });
  return String(id);
};
const fixtureUser = async (id: string) => {
  const user = await userRepository.findById(id);
  if (!user) throw new Error('Fixture user is missing');
  return user;
};
const restoreFixtureFile = async (fileId: mongoose.Types.ObjectId, deletedAt: Date) => {
  const restored = await fabFileRepository.undeleteByDataLakeTag(
    { kind: 'owned', datalakeTag: 'datalake:grant-fixture' },
    [],
    deletedAt
  );
  expect(restored.map(file => file.id)).toContain(String(fileId));
};

describe('committed grant-loss closure', () => {
  it('rolls back grant removals and reference pruning together when the transaction aborts', async () => {
    const owner = await seedUser();
    const recipient = await seedUser();
    const member = await seedUser();
    const fileId = oid();
    const projectId = await seedProject(recipient, [projectRow(member)], { fileIds: [String(fileId)] });
    const grants = [projectRow(recipient), { ...projectRow(member), projectId }];
    await seedFile(fileId, owner, { users: grants });

    await expect(
      withTransaction(async () => {
        await sharingService.revoke(
          owner,
          {
            id: String(fileId),
            type: 'files',
            userId: recipient,
          },
          { db: sharingDb }
        );
        throw new Error('abort fixture');
      })
    ).rejects.toThrow('abort fixture');

    expect((await FabFile.collection.findOne({ _id: fileId }))?.users).toEqual(grants);
    expect((await Project.collection.findOne({ _id: new mongoose.Types.ObjectId(projectId) }))?.fileIds).toEqual([
      String(fileId),
    ]);
    expect(
      await fabFileRepository.shareable.findAccessibleById(await fixtureUser(member), String(fileId))
    ).not.toBeNull();
  });

  it.each([false, true])(
    'follows every recipient from session-only source files (already deleted: %s)',
    async tombstoned => {
      const owner = await seedUser();
      const recipient = await seedUser();
      const member = await seedUser();
      const downstream = await seedUser();
      const independent = await seedUser();
      const fileId = oid();
      const sessionId = oid();
      const projectId = await seedProject(recipient, [projectRow(member)], {
        fileIds: [String(fileId).toUpperCase()],
        systemPrompts: [{ fileId: String(fileId).toUpperCase(), enabled: true }],
      });
      const downstreamProject = await seedProject(member, [projectRow(downstream, ['read'])], {
        fileIds: [String(fileId)],
      });
      const deletedAt = new Date('2026-01-01');
      const direct = { userId: independent, permissions: ['read'] };
      await seedFile(fileId, owner, {
        deletedAt: tombstoned ? deletedAt : null,
        tags: [{ name: 'datalake:grant-fixture', strength: 1 }],
        users: [
          { ...projectRow(recipient), sessionId: String(sessionId) },
          { ...projectRow(member), projectId },
          { ...projectRow(downstream, ['read']), projectId: downstreamProject },
          direct,
        ],
      });
      await Session.collection.insertOne({
        _id: sessionId,
        userId: owner,
        users: [projectRow(recipient)],
        groups: [],
        knowledgeIds: [String(fileId)],
        deletedAt: null,
        __v: 0,
      });
      const actors = new Set<string>();
      await withTransaction(() =>
        sharingService.revoke(
          owner,
          {
            id: String(sessionId),
            type: 'sessions',
            userId: recipient,
          },
          { db: sharingDb, onAccessRemoved: ids => ids.forEach(id => actors.add(id)) }
        )
      );

      const file = await FabFile.collection.findOne({ _id: fileId });
      expect(file?.users).toEqual([direct]);
      expect(file?.deletedAt).toEqual(tombstoned ? deletedAt : null);
      expect((await Project.collection.findOne({ _id: new mongoose.Types.ObjectId(projectId) }))?.fileIds).toEqual([]);
      expect(
        (await Project.collection.findOne({ _id: new mongoose.Types.ObjectId(projectId) }))?.systemPrompts
      ).toEqual([]);
      expect(
        (await Project.collection.findOne({ _id: new mongoose.Types.ObjectId(downstreamProject) }))?.fileIds
      ).toEqual([]);
      expect([...actors]).toEqual(expect.arrayContaining([recipient, member, downstream]));
      if (tombstoned) await restoreFixtureFile(fileId, deletedAt);
      expect(
        await fabFileRepository.shareable.findAccessibleById(await fixtureUser(member), String(fileId))
      ).toBeNull();
      expect(
        await fabFileRepository.shareable.findAccessibleById(await fixtureUser(downstream), String(fileId))
      ).toBeNull();
    }
  );

  it('discovers an update-only contributor through the real attach and revoke flow', async () => {
    const owner = await seedUser();
    const contributor = await seedUser();
    const projectOwner = await seedUser();
    const member = await seedUser();
    const fileId = oid();
    await seedFile(fileId, owner, { users: [projectRow(contributor)] });
    const projectId = await seedProject(projectOwner, [
      projectRow(contributor, ['update']),
      projectRow(member, ['read']),
    ]);
    await withTransaction(async () =>
      projectService.addFiles(
        await fixtureUser(contributor),
        {
          projectId,
          fileIds: [String(fileId)],
        },
        { db: sharingDb }
      )
    );
    expect((await FabFile.collection.findOne({ _id: fileId }))?.users).toEqual(
      expect.arrayContaining([expect.objectContaining({ userId: member, projectId })])
    );

    await withTransaction(() =>
      sharingService.revoke(
        owner,
        {
          id: String(fileId),
          type: 'files',
          userId: contributor,
        },
        { db: sharingDb }
      )
    );

    expect((await Project.collection.findOne({ _id: new mongoose.Types.ObjectId(projectId) }))?.fileIds).toEqual([]);
    expect((await FabFile.collection.findOne({ _id: fileId }))?.users).toEqual([]);
  });

  it('uses the pending project membership when pruning a departing owners contributions', async () => {
    const owner = await seedUser();
    const contributor = await seedUser();
    const member = await seedUser();
    const downstream = await seedUser();
    const fileId = oid();
    await seedFile(fileId, contributor);
    const projectId = await seedProject(owner, [projectRow(contributor, ['read', 'update']), projectRow(member)]);
    const downstreamProject = await seedProject(member, [projectRow(downstream, ['read'])]);
    await withTransaction(async () =>
      projectService.addFiles(
        await fixtureUser(contributor),
        { projectId, fileIds: [String(fileId)] },
        { db: sharingDb }
      )
    );
    await withTransaction(async () =>
      projectService.addFiles(
        await fixtureUser(member),
        { projectId: downstreamProject, fileIds: [String(fileId)] },
        { db: sharingDb }
      )
    );

    await withTransaction(() =>
      sharingService.revoke(owner, { id: projectId, type: 'projects', userId: contributor }, { db: sharingDb })
    );

    const project = await Project.collection.findOne({ _id: new mongoose.Types.ObjectId(projectId) });
    expect(project?.fileIds).toEqual([]);
    expect(project?.users).toEqual([projectRow(member)]);
    expect(
      (await Project.collection.findOne({ _id: new mongoose.Types.ObjectId(downstreamProject) }))?.fileIds
    ).toEqual([]);
    expect((await FabFile.collection.findOne({ _id: fileId }))?.users).toEqual([]);
  });

  it.each([false, true])(
    'counts the revokee owner group support after the direct grant is gone (retained: %s)',
    async retained => {
      const groupId = String(oid());
      const owner = await seedUser();
      const recipient = await seedUser(undefined, retained ? [groupId] : []);
      const member = await seedUser();
      const fileId = oid();
      const projectId = await seedProject(recipient, [projectRow(member, ['read'])], {
        fileIds: [String(fileId).toUpperCase()],
      });
      await seedFile(fileId, owner, {
        users: [projectRow(recipient), { ...projectRow(member, ['read']), projectId }],
        groups: [{ groupId, permissions: ['read', 'share'] }],
      });
      await withTransaction(() =>
        sharingService.revoke(owner, { id: String(fileId), type: 'files', userId: recipient }, { db: sharingDb })
      );
      expect((await Project.collection.findOne({ _id: new mongoose.Types.ObjectId(projectId) }))?.fileIds).toEqual(
        retained ? [String(fileId).toUpperCase()] : []
      );
      const readable = await fabFileRepository.shareable.findAccessibleById(await fixtureUser(member), String(fileId));
      expect(!!readable).toBe(retained);
    }
  );
});

it.each([false, true])(
  'deleting a notebook cleans copied project grants without session-tagged files (already deleted: %s)',
  async tombstoned => {
    const owner = await seedUser();
    const notebookOwner = await seedUser();
    const member = await seedUser();
    const downstream = await seedUser();
    const fileId = oid();
    await seedFile(fileId, owner, { tags: [{ name: 'datalake:grant-fixture', strength: 1 }] });
    const independentProject = await seedProject(owner, [projectRow(notebookOwner)]);
    const projectId = await seedProject(notebookOwner, [projectRow(member)]);
    const downstreamProject = await seedProject(member, [projectRow(downstream, ['read'])]);
    const sessionId = oid();
    await Session.collection.insertOne({
      _id: sessionId,
      userId: notebookOwner,
      users: [],
      groups: [],
      knowledgeIds: [String(fileId)],
      deletedAt: null,
      __v: 0,
    });
    await withTransaction(async () =>
      projectService.addFiles(
        await fixtureUser(owner),
        {
          projectId: independentProject,
          fileIds: [String(fileId)],
        },
        { db: sharingDb }
      )
    );
    await withTransaction(async () =>
      projectService.addSessions(
        await fixtureUser(notebookOwner),
        {
          projectId,
          sessionIds: [String(sessionId)],
        },
        { db: sharingDb }
      )
    );
    await withTransaction(async () =>
      projectService.addFiles(
        await fixtureUser(member),
        {
          projectId: downstreamProject,
          fileIds: [String(fileId)],
        },
        { db: sharingDb }
      )
    );
    const before = await FabFile.collection.findOne({ _id: fileId });
    expect(before?.users.every((row: { sessionId?: string }) => !row.sessionId)).toBe(true);
    expect(before?.users).toEqual(expect.arrayContaining([expect.objectContaining({ userId: member, projectId })]));
    const deletedAt = new Date('2026-01-01');
    if (tombstoned) await FabFile.updateOne({ _id: fileId }, { $set: { deletedAt } });
    const actors = new Set<string>();
    await withTransaction(() =>
      sessionService.deleteSession(
        notebookOwner,
        { id: String(sessionId) },
        {
          db: { ...sharingDb, organizations: organizationRepository },
          onAccessRemoved: ids => ids.forEach(id => actors.add(id)),
        }
      )
    );

    const file = await FabFile.collection.findOne({ _id: fileId });
    expect(file?.users).toEqual([expect.objectContaining({ userId: notebookOwner, projectId: independentProject })]);
    expect(file?.deletedAt).toEqual(tombstoned ? deletedAt : null);
    expect((await Project.collection.findOne({ _id: new mongoose.Types.ObjectId(projectId) }))?.fileIds).toEqual([]);
    expect((await Project.collection.findOne({ _id: new mongoose.Types.ObjectId(projectId) }))?.sessionIds).toEqual([]);
    expect(
      (await Project.collection.findOne({ _id: new mongoose.Types.ObjectId(downstreamProject) }))?.fileIds
    ).toEqual([]);
    expect(
      (await Project.collection.findOne({ _id: new mongoose.Types.ObjectId(independentProject) }))?.fileIds
    ).toEqual([String(fileId)]);
    expect([...actors]).toEqual(expect.arrayContaining([member, downstream]));
    if (tombstoned) await restoreFixtureFile(fileId, deletedAt);
    expect(await fabFileRepository.shareable.findAccessibleById(await fixtureUser(member), String(fileId))).toBeNull();
  }
);

it('follows a scoped project departure through an already-deleted file and preserves its tombstone', async () => {
  const owner = await seedUser();
  const departing = await seedUser();
  const downstream = await seedUser();
  const fileId = oid();
  await seedFile(fileId, owner, { tags: [{ name: 'datalake:grant-fixture', strength: 1 }] });
  const projectId = await seedProject(owner, [projectRow(departing)]);
  const downstreamProject = await seedProject(departing, [projectRow(downstream, ['read'])]);
  await withTransaction(async () =>
    projectService.addFiles(await fixtureUser(owner), { projectId, fileIds: [String(fileId)] }, { db: sharingDb })
  );
  await withTransaction(async () =>
    projectService.addFiles(
      await fixtureUser(departing),
      { projectId: downstreamProject, fileIds: [String(fileId)] },
      { db: sharingDb }
    )
  );
  const deletedAt = new Date('2026-01-01');
  await FabFile.updateOne({ _id: fileId }, { $set: { deletedAt } });

  await withTransaction(async () =>
    projectService.leaveProject(await fixtureUser(departing), { id: projectId }, { db: sharingDb })
  );

  const file = await FabFile.collection.findOne({ _id: fileId });
  expect(file?.users).toEqual([]);
  expect(file?.deletedAt).toEqual(deletedAt);
  expect((await Project.collection.findOne({ _id: new mongoose.Types.ObjectId(projectId) }))?.fileIds).toEqual([
    String(fileId),
  ]);
  expect((await Project.collection.findOne({ _id: new mongoose.Types.ObjectId(downstreamProject) }))?.fileIds).toEqual(
    []
  );
  await restoreFixtureFile(fileId, deletedAt);
  expect(await fabFileRepository.shareable.findAccessibleById(await fixtureUser(departing), String(fileId))).toBeNull();
  expect(
    await fabFileRepository.shareable.findAccessibleById(await fixtureUser(downstream), String(fileId))
  ).toBeNull();
});
