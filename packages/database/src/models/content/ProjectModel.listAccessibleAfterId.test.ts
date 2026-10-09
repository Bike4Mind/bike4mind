import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
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
