import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { accessibleBy } from '@casl/mongoose';
import { Permission, type IUserDocument } from '@bike4mind/common';
import { createMongoServer } from '../../__test__/createMongoServer';
import { defineAbilitiesFor } from '../../utils/ability';
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

const caslScope = (userId: string) =>
  accessibleBy(defineAbilitiesFor({ id: userId, groups: [] } as unknown as IUserDocument), Permission.read).ofType(
    Project
  );

async function collectAllPages(userId: string, limit: number, scope?: Record<string, unknown>) {
  const ids: string[] = [];
  let afterId: string | undefined;
  for (let guard = 0; guard < 20; guard++) {
    const page = await projectRepository.listAccessibleAfterId(userId, { scope, afterId, limit });
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

    expect(await collectAllPages(OWNER, 2)).toEqual(expected);
  });

  it('reports hasMore only while another page exists', async () => {
    await makeProject('a');
    await makeProject('b');

    const exact = await projectRepository.listAccessibleAfterId(OWNER, { limit: 2 });
    expect(exact.data).toHaveLength(2);
    expect(exact.hasMore).toBe(false);

    const short = await projectRepository.listAccessibleAfterId(OWNER, { limit: 1 });
    expect(short.hasMore).toBe(true);
  });

  it('keeps the access predicate on every page: foreign and soft-deleted projects never appear', async () => {
    const mine = await makeProject('mine');
    const shared = await makeProject('shared', { userId: OTHER, users: [{ userId: OWNER, permissions: ['read'] }] });
    await makeProject('foreign', { userId: OTHER });
    const deleted = await makeProject('deleted');
    await Project.deleteOne({ _id: deleted._id });

    const expected = [String(mine.id), String(shared.id)].sort();
    expect(await collectAllPages(OWNER, 1)).toEqual(expected);
    expect(await collectAllPages(OWNER, 1, caslScope(OWNER))).toEqual(expected);
  });

  it('applies a caller scope alongside the cursor rather than letting either replace the other', async () => {
    const first = await makeProject('first');
    await makeProject('foreign', { userId: OTHER });
    const second = await makeProject('second');

    const page = await projectRepository.listAccessibleAfterId(OWNER, {
      scope: caslScope(OWNER),
      afterId: String(first.id),
      limit: 10,
    });
    expect(page.data.map(project => String(project.id))).toEqual([String(second.id)]);
  });

  it('rejects a non-ObjectId cursor id instead of sending it to Mongo', async () => {
    await expect(projectRepository.listAccessibleAfterId(OWNER, { afterId: 'nope', limit: 1 })).rejects.toThrow(
      /Invalid project cursor id/
    );
  });
});
