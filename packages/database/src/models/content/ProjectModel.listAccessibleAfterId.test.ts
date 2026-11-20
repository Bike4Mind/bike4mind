import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer } from '../../__test__/createMongoServer';
import { Project, projectRepository } from './ProjectModel';

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
  await Project.syncIndexes();
});
afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});
beforeEach(async () => {
  await Project.deleteMany({}, { hardDelete: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const OWNER = 'user-owner';
const OTHER = 'user-other';
const GROUP = 'group-1';
const ACTOR = { id: OWNER, groups: [GROUP] };

const makeProject = (name: string, overrides: Record<string, unknown> = {}) =>
  Project.create({
    name,
    description: `${name} description`,
    userId: OWNER,
    sessionIds: [],
    fileIds: [],
    systemPrompts: [],
    users: [],
    groups: [],
    isGlobalRead: false,
    isGlobalWrite: false,
    ...overrides,
  });

async function collectAllPages(limit: number) {
  const ids: string[] = [];
  let afterId: string | undefined;
  for (let guard = 0; guard < 20; guard++) {
    const page = await projectRepository.listAccessibleAfterId(ACTOR, { afterId, limit });
    expect(page.data.length).toBeLessThanOrEqual(limit);
    ids.push(...page.data.map(project => String(project.id)));
    if (!page.hasMore) return ids;
    afterId = ids[ids.length - 1];
  }
  throw new Error('pagination did not terminate');
}

describe('ProjectRepository.listAccessibleAfterId', () => {
  it('grants and revokes group read access without changing other shares', async () => {
    const project = await makeProject('group-management', {
      groups: [{ groupId: 'other-group', permissions: ['read', 'update'] }],
      users: [{ userId: 'direct-member', permissions: ['read'] }],
    });
    const member = { id: OTHER, groups: [GROUP] };
    expect(await projectRepository.shareable.findAccessibleById(member, project.id)).toBeNull();
    expect(await projectRepository.setOwnedGroupReadAccess(project.id, OTHER, GROUP, true)).toBe(false);
    expect(await projectRepository.setOwnedGroupReadAccess(project.id, OWNER, GROUP, true)).toBe(true);
    await projectRepository.setOwnedGroupReadAccess(project.id, OWNER, GROUP, true);
    expect(await projectRepository.shareable.findAccessibleById(member, project.id)).not.toBeNull();
    expect(await projectRepository.shareable.findAccessibleById({ id: OTHER, groups: [] }, project.id)).toBeNull();
    expect(await projectRepository.shareable.findUpdateAccessById(member, project.id)).toBeNull();
    const shared = await projectRepository.findById(project.id);
    expect(shared?.groups).toHaveLength(2);
    expect(shared?.users).toEqual(expect.arrayContaining([expect.objectContaining({ userId: 'direct-member' })]));
    await projectRepository.setOwnedGroupReadAccess(project.id, OWNER, GROUP, false);
    expect(await projectRepository.shareable.findAccessibleById(member, project.id)).toBeNull();
    expect((await projectRepository.findById(project.id))?.groups).toEqual([
      expect.objectContaining({ groupId: 'other-group', permissions: ['read', 'update'] }),
    ]);
    await Project.deleteOne({ _id: project._id });
    expect(await projectRepository.setOwnedGroupReadAccess(project.id, OWNER, GROUP, true)).toBe(false);
  });

  it('keeps an existing broader group grant when enabling group access', async () => {
    const project = await makeProject('group-broader', {
      groups: [{ groupId: GROUP, permissions: ['read', 'update'] }],
    });
    const member = { id: OTHER, groups: [GROUP] };
    expect(await projectRepository.setOwnedGroupReadAccess(project.id, OWNER, GROUP, true)).toBe(true);
    const shared = await projectRepository.findById(project.id);
    expect(shared?.groups).toHaveLength(1);
    expect(shared?.groups[0]).toEqual(expect.objectContaining({ groupId: GROUP, permissions: ['read', 'update'] }));
    expect(await projectRepository.shareable.findUpdateAccessById(member, project.id)).not.toBeNull();
  });

  it('uses only ordinary updates and scopes every write and idempotent read to the live owner', async () => {
    const project = await makeProject('ordinary-group-updates');
    const writes = vi.spyOn(Project, 'updateOne');
    const reads = vi.spyOn(Project, 'findOne');
    await projectRepository.setOwnedGroupReadAccess(project.id, OWNER, GROUP, true);
    await projectRepository.setOwnedGroupReadAccess(project.id, OWNER, GROUP, true);
    await projectRepository.setOwnedGroupReadAccess(project.id, OWNER, GROUP, false);
    expect(writes.mock.calls.length).toBeGreaterThan(0);
    for (const [filter, update] of writes.mock.calls) {
      expect(filter).toMatchObject({ userId: OWNER, deletedAt: null });
      expect(Array.isArray(update)).toBe(false);
      expect(Object.keys(update ?? {}).every(key => ['$set', '$push', '$pull'].includes(key))).toBe(true);
    }
    for (const [filter] of reads.mock.calls) expect(filter).toMatchObject({ userId: OWNER, deletedAt: null });
  });

  it.each([
    ['null', true],
    ['null', false],
    ['missing', true],
    ['missing', false],
  ] as const)('handles a %s legacy group array when enabled=%s', async (shape, enabled) => {
    const project = await makeProject(`legacy-${shape}-${enabled}`);
    await Project.collection.updateOne(
      { _id: project._id },
      shape === 'null' ? { $set: { groups: null } } : { $unset: { groups: 1 } }
    );
    expect(await projectRepository.setOwnedGroupReadAccess(project.id, OWNER, GROUP, enabled)).toBe(true);
    expect((await projectRepository.findById(project.id))?.groups).toEqual(
      enabled ? [expect.objectContaining({ groupId: GROUP, permissions: ['read'] })] : []
    );
  });

  it('preserves an existing array containing a legacy null element and an unrelated grant', async () => {
    const project = await makeProject('legacy-null-element');
    const other = { groupId: 'other-group', permissions: ['read', 'update'] };
    await Project.collection.updateOne({ _id: project._id }, { $set: { groups: [null, other] } });
    expect(await projectRepository.setOwnedGroupReadAccess(project.id, OWNER, GROUP, true)).toBe(true);
    const stored = await Project.collection.findOne({ _id: project._id });
    expect(stored?.groups).toEqual([
      null,
      expect.objectContaining(other),
      expect.objectContaining({ groupId: GROUP, permissions: ['read'] }),
    ]);
  });

  it('does not duplicate a group across concurrent enables', async () => {
    const project = await makeProject('concurrent-group-enables');
    expect(
      await Promise.all([1, 2, 3].map(() => projectRepository.setOwnedGroupReadAccess(project.id, OWNER, GROUP, true)))
    ).toEqual([true, true, true]);
    expect((await projectRepository.findById(project.id))?.groups).toHaveLength(1);
  });

  it('retains concurrent unrelated group grants with the snapshot comparison', async () => {
    const project = await makeProject('concurrent-different-groups');
    expect(
      await Promise.all(
        [GROUP, 'second-group'].map(groupId =>
          projectRepository.setOwnedGroupReadAccess(project.id, OWNER, groupId, true)
        )
      )
    ).toEqual([true, true]);
    const groups = (await projectRepository.findById(project.id))?.groups ?? [];
    expect(groups.map(group => group.groupId).sort()).toEqual([GROUP, 'second-group'].sort());
  });

  it('compares legacy grants without synthesizing missing subdocument IDs', async () => {
    const project = await makeProject('legacy-no-subdocument-id');
    const legacy = { groupId: 'other-group', permissions: ['read', 'update'] };
    await Project.collection.updateOne({ _id: project._id }, { $set: { groups: [legacy] } });
    expect(await projectRepository.setOwnedGroupReadAccess(project.id, OWNER, GROUP, true)).toBe(true);
    expect((await projectRepository.findById(project.id))?.groups).toEqual(
      expect.arrayContaining([expect.objectContaining(legacy), expect.objectContaining({ groupId: GROUP })])
    );
  });

  it('reports a retryable conflict instead of silently losing grants when the snapshot keeps changing', async () => {
    const project = await makeProject('contended-groups');
    const writes = vi
      .spyOn(Project, 'updateOne')
      .mockResolvedValue({ acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 0, upsertedId: null });
    await expect(projectRepository.setOwnedGroupReadAccess(project.id, OWNER, GROUP, true)).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(writes.mock.calls.length).toBeGreaterThan(0);
    expect(writes.mock.calls.length).toBeLessThanOrEqual(3);
    expect((await projectRepository.findById(project.id))?.groups).toEqual([]);
  });

  it('walks every accessible project once, in ascending _id order, across keyset pages', async () => {
    const created = [];
    for (let index = 0; index < 5; index++) created.push(await makeProject(`p${index}`));
    const expected = created.map(project => String(project.id)).sort();

    expect(await collectAllPages(2)).toEqual(expected);
  });

  it('reports hasMore only while another page exists', async () => {
    await makeProject('a');
    await makeProject('b');

    const exact = await projectRepository.listAccessibleAfterId(ACTOR, { limit: 2 });
    expect(exact.data).toHaveLength(2);
    expect(exact.hasMore).toBe(false);

    const short = await projectRepository.listAccessibleAfterId(ACTOR, { limit: 1 });
    expect(short.hasMore).toBe(true);
  });

  it('pages owner, user-share and group-share reach, and nothing get would refuse', async () => {
    const mine = await makeProject('mine');
    const userShared = await makeProject('user-shared', {
      userId: OTHER,
      users: [{ userId: OWNER, permissions: ['read'] }],
    });
    const groupShared = await makeProject('group-shared', {
      userId: OTHER,
      groups: [{ groupId: GROUP, permissions: ['read'] }],
    });
    const globalRead = await makeProject('global-read', { userId: OTHER, isGlobalRead: true });
    await makeProject('share-only', { userId: OTHER, users: [{ userId: OWNER, permissions: ['share'] }] });
    await makeProject('foreign', { userId: OTHER });
    const deleted = await makeProject('deleted');
    await Project.deleteOne({ _id: deleted._id });

    const listed = await collectAllPages(1);

    expect(listed).toEqual([String(mine.id), String(userShared.id), String(groupShared.id)].sort());
    expect(listed).not.toContain(String(globalRead.id));
    // Parity with the by-id read, both directions: every listed id resolves, and the rows the list
    // leaves out are exactly the ones findAccessibleById also refuses.
    for (const id of listed) expect(await projectRepository.shareable.findAccessibleById(ACTOR, id)).not.toBeNull();
    expect(await projectRepository.shareable.findAccessibleById(ACTOR, String(globalRead.id))).toBeNull();
  });

  it('still lists my own globally readable project', async () => {
    const mine = await makeProject('mine-global', { isGlobalRead: true });
    expect(await collectAllPages(5)).toEqual([String(mine.id)]);
  });

  it('rejects a non-ObjectId cursor id instead of sending it to Mongo', async () => {
    await expect(projectRepository.listAccessibleAfterId(ACTOR, { afterId: 'nope', limit: 1 })).rejects.toThrow(
      /Invalid project cursor id/
    );
  });
});
