import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoServer } from '../../__test__/createMongoServer';
import { MAX_GRAPH_ITEMS, WorkItem, workItemRepository } from './WorkItemModel';

const USER = 'user-1';
const OTHER_USER = 'user-2';

const create = async (title: string, overrides: Record<string, unknown> = {}) => {
  const doc = await WorkItem.create({ userId: USER, title, status: 'open', dependencies: [], ...overrides });
  return doc.toJSON();
};

describe('WorkItemRepository', () => {
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
    await WorkItem.deleteMany({});
  });

  describe('listForUser', () => {
    it("returns only the caller's live items", async () => {
      await create('Mine');
      await create('Theirs', { userId: OTHER_USER });
      const deleted = await create('Deleted');
      await workItemRepository.softDeleteForUser(deleted.id, USER);

      const result = await workItemRepository.listForUser(
        USER,
        {},
        { page: 1, limit: 10 },
        { by: 'createdAt', direction: 'asc' }
      );

      expect(result.data.map(i => i.title)).toEqual(['Mine']);
      expect(result.total).toBe(1);
      expect(result.hasMore).toBe(false);
    });

    it('paginates with an accurate hasMore', async () => {
      await create('A');
      await create('B');
      await create('C');

      const page1 = await workItemRepository.listForUser(
        USER,
        {},
        { page: 1, limit: 2 },
        { by: 'title', direction: 'asc' }
      );
      const page2 = await workItemRepository.listForUser(
        USER,
        {},
        { page: 2, limit: 2 },
        { by: 'title', direction: 'asc' }
      );

      expect(page1.data.map(i => i.title)).toEqual(['A', 'B']);
      expect(page1.hasMore).toBe(true);
      expect(page1.total).toBe(3);
      expect(page2.data.map(i => i.title)).toEqual(['C']);
      expect(page2.hasMore).toBe(false);
    });

    it('filters by status', async () => {
      await create('Open one');
      await create('Blocked one', { status: 'blocked' });

      const result = await workItemRepository.listForUser(
        USER,
        { status: ['blocked'] },
        { page: 1, limit: 10 },
        { by: 'createdAt', direction: 'asc' }
      );

      expect(result.data.map(i => i.title)).toEqual(['Blocked one']);
    });

    it('searches title and description case-insensitively', async () => {
      await create('Deploy the gateway');
      await create('Unrelated', { description: 'mentions DEPLOY in the body' });
      await create('Nothing to see');

      const result = await workItemRepository.listForUser(
        USER,
        { search: 'deploy' },
        { page: 1, limit: 10 },
        { by: 'createdAt', direction: 'asc' }
      );

      expect(result.data.map(i => i.title).sort()).toEqual(['Deploy the gateway', 'Unrelated']);
    });

    it('treats a regex metacharacter in search as a literal', async () => {
      await create('Costs 5$ total');
      await create('Something else');

      const result = await workItemRepository.listForUser(
        USER,
        { search: '5$' },
        { page: 1, limit: 10 },
        { by: 'createdAt', direction: 'asc' }
      );

      expect(result.data.map(i => i.title)).toEqual(['Costs 5$ total']);
    });
  });

  describe('findByIdForUser', () => {
    it("returns null for another user's item rather than leaking it", async () => {
      const theirs = await create('Theirs', { userId: OTHER_USER });

      expect(await workItemRepository.findByIdForUser(theirs.id, USER)).toBeNull();
    });

    it('returns null for a malformed id instead of throwing a cast error', async () => {
      expect(await workItemRepository.findByIdForUser('not-an-object-id', USER)).toBeNull();
    });
  });

  describe('findManyByIdsForUser', () => {
    it('returns only owned, live items and drops invalid ids', async () => {
      const mine = await create('Mine');
      const theirs = await create('Theirs', { userId: OTHER_USER });

      const found = await workItemRepository.findManyByIdsForUser([mine.id, theirs.id, 'garbage'], USER);

      expect(found.map(i => i.id)).toEqual([mine.id]);
    });
  });

  describe('listReadyForUser', () => {
    it('includes an open item with no dependencies', async () => {
      await create('Standalone');

      const ready = await workItemRepository.listReadyForUser(USER);

      expect(ready.data.map(i => i.title)).toEqual(['Standalone']);
      expect(ready.truncated).toBe(false);
    });

    it('excludes an item whose dependency is still open, and includes it once closed', async () => {
      const blocker = await create('Blocker');
      await create('Dependent', { dependencies: [blocker.id] });

      expect((await workItemRepository.listReadyForUser(USER)).data.map(i => i.title)).toEqual(['Blocker']);

      await workItemRepository.updateForUser(blocker.id, USER, { status: 'closed' });

      expect((await workItemRepository.listReadyForUser(USER)).data.map(i => i.title)).toEqual(['Dependent']);
    });

    it('excludes in_progress and blocked items', async () => {
      await create('Underway', { status: 'in_progress' });
      await create('Held back', { status: 'blocked' });

      expect((await workItemRepository.listReadyForUser(USER)).data).toEqual([]);
    });

    it('treats a deleted dependency as satisfied rather than blocking forever', async () => {
      const blocker = await create('Blocker');
      await create('Dependent', { dependencies: [blocker.id] });
      await workItemRepository.softDeleteForUser(blocker.id, USER);

      expect((await workItemRepository.listReadyForUser(USER)).data.map(i => i.title)).toEqual(['Dependent']);
    });
  });

  describe('the whole-graph read window', () => {
    // Fills the window exactly, so the reported answer is still complete but the
    // caller has no way to know that - hence the flag rather than silence.
    const fillWindow = async () =>
      WorkItem.insertMany(
        Array.from({ length: MAX_GRAPH_ITEMS }, (_, i) => ({
          userId: USER,
          title: `Item ${i}`,
          status: 'open',
          dependencies: [],
        }))
      );

    it('does not flag a backlog that fits', async () => {
      await create('Standalone');

      expect((await workItemRepository.listReadyForUser(USER)).truncated).toBe(false);
      expect((await workItemRepository.buildGraphForUser(USER)).truncated).toBe(false);
    });

    it('flags ready and graph once the backlog fills the window', async () => {
      await fillWindow();

      const ready = await workItemRepository.listReadyForUser(USER);
      const graph = await workItemRepository.buildGraphForUser(USER);

      expect(ready.truncated).toBe(true);
      expect(ready.data).toHaveLength(MAX_GRAPH_ITEMS);
      expect(graph.truncated).toBe(true);
      expect(graph.nodes).toHaveLength(MAX_GRAPH_ITEMS);
    });
  });

  describe('buildGraphForUser', () => {
    it('emits a node per item and an edge per resolvable dependency', async () => {
      const first = await create('First');
      const second = await create('Second', { dependencies: [first.id] });

      const graph = await workItemRepository.buildGraphForUser(USER);

      expect(graph.nodes.map(n => n.title)).toEqual(['First', 'Second']);
      expect(graph.edges).toEqual([{ from: second.id, to: first.id }]);
      expect(graph.cycles).toEqual([]);
    });

    it('drops edges pointing at items that no longer exist', async () => {
      const ghost = new mongoose.Types.ObjectId().toString();
      await create('Orphan', { dependencies: [ghost] });

      const graph = await workItemRepository.buildGraphForUser(USER);

      expect(graph.edges).toEqual([]);
    });

    it('reports every member of a cycle written directly to the database', async () => {
      const a = await create('A');
      const b = await create('B', { dependencies: [a.id] });
      // Bypass the API's cycle guard to simulate legacy or hand-edited data.
      await WorkItem.updateOne({ _id: a.id }, { $set: { dependencies: [b.id] } });

      const graph = await workItemRepository.buildGraphForUser(USER);

      expect(graph.cycles.sort()).toEqual([a.id, b.id].sort());
    });
  });

  describe('detectDependencyCycle', () => {
    it('is false for an empty dependency list', async () => {
      expect(await workItemRepository.detectDependencyCycle(USER, [])).toBe(false);
    });

    it('is false for a dependency that does not lead back', async () => {
      const a = await create('A');

      expect(await workItemRepository.detectDependencyCycle(USER, [a.id])).toBe(false);
    });

    it('detects a direct two-item cycle', async () => {
      const a = await create('A');
      const b = await create('B', { dependencies: [a.id] });

      expect(await workItemRepository.detectDependencyCycle(USER, [b.id], a.id)).toBe(true);
    });

    it('detects a longer transitive cycle', async () => {
      const a = await create('A');
      const b = await create('B', { dependencies: [a.id] });
      const c = await create('C', { dependencies: [b.id] });

      expect(await workItemRepository.detectDependencyCycle(USER, [c.id], a.id)).toBe(true);
    });

    it('allows a diamond, which is acyclic', async () => {
      const root = await create('Root');
      const left = await create('Left', { dependencies: [root.id] });
      const right = await create('Right', { dependencies: [root.id] });

      expect(await workItemRepository.detectDependencyCycle(USER, [left.id, right.id])).toBe(false);
    });
  });

  describe('updateForUser', () => {
    it('clears closedAt via $unset when passed null', async () => {
      const itemId = (await create('Closed', { status: 'closed', closedAt: new Date() })).id;

      const updated = await workItemRepository.updateForUser(itemId, USER, { status: 'open', closedAt: null });

      expect(updated?.status).toBe('open');
      expect(updated?.closedAt).toBeUndefined();
    });

    it('clears description via $unset when passed null', async () => {
      const itemId = (await create('Documented', { description: 'the old detail' })).id;

      const updated = await workItemRepository.updateForUser(itemId, USER, { description: null });

      expect(updated?.description).toBeUndefined();
    });

    it('leaves description untouched when the field is omitted', async () => {
      const itemId = (await create('Documented', { description: 'the old detail' })).id;

      const updated = await workItemRepository.updateForUser(itemId, USER, { title: 'Renamed' });

      expect(updated?.description).toBe('the old detail');
    });

    it("refuses to update another user's item", async () => {
      const theirs = await create('Theirs', { userId: OTHER_USER });

      expect(await workItemRepository.updateForUser(theirs.id, USER, { title: 'Hijacked' })).toBeNull();
      expect((await WorkItem.findById(theirs.id))?.title).toBe('Theirs');
    });

    it('rejects a status outside the enum', async () => {
      const itemId = (await create('A')).id;

      await expect(workItemRepository.updateForUser(itemId, USER, { status: 'wat' as never })).rejects.toThrow();
    });
  });

  describe('softDeleteForUser', () => {
    it('hides the item without erasing it', async () => {
      const itemId = (await create('Doomed')).id;

      expect(await workItemRepository.softDeleteForUser(itemId, USER)).toBe(true);
      expect(await workItemRepository.findByIdForUser(itemId, USER)).toBeNull();
      // The plugin filters deleted docs out of Mongoose queries, so prove the
      // row survives by going straight to the driver.
      const raw = await WorkItem.collection.findOne({ _id: new mongoose.Types.ObjectId(itemId) });
      expect(raw?.deletedAt).toBeInstanceOf(Date);
    });

    it('is idempotent - a second delete reports no match', async () => {
      const itemId = (await create('Doomed')).id;
      await workItemRepository.softDeleteForUser(itemId, USER);

      expect(await workItemRepository.softDeleteForUser(itemId, USER)).toBe(false);
    });

    it("refuses to delete another user's item", async () => {
      const theirs = await create('Theirs', { userId: OTHER_USER });

      expect(await workItemRepository.softDeleteForUser(theirs.id, USER)).toBe(false);
    });
  });

  describe('loop tickets', () => {
    const LOOP = 'loop-1';
    const ticket = (title: string, overrides: Record<string, unknown> = {}) =>
      create(title, { loopId: LOOP, stage: 'todo', ...overrides });

    it('declares the loop and execution indexes', async () => {
      await WorkItem.syncIndexes();
      const keys = (await WorkItem.collection.indexes()).map(index => index.key);
      expect(keys).toEqual(
        expect.arrayContaining([{ loopId: 1, deletedAt: 1, status: 1, stage: 1 }, { executionId: 1 }])
      );
    });

    it('are hidden from list and ready unless filtered by loop, but still gate plain items', async () => {
      const blocker = await ticket('Loop ticket');
      await create('Plain', { dependencies: [blocker.id] });
      await create('Free');

      const plain = await workItemRepository.listForUser(
        USER,
        {},
        { page: 1, limit: 50 },
        { by: 'createdAt', direction: 'asc' }
      );
      expect(plain.data.map(item => item.title)).toEqual(['Plain', 'Free']);

      const loop = await workItemRepository.listForUser(
        USER,
        { loopId: LOOP },
        { page: 1, limit: 50 },
        { by: 'createdAt', direction: 'asc' }
      );
      expect(loop.data.map(item => item.title)).toEqual(['Loop ticket']);

      const ready = await workItemRepository.listReadyForUser(USER);
      expect(ready.data.map(item => item.title)).toEqual(['Free']);
    });

    it('findNextReadyForLoop picks the oldest open ticket with closed deps, outside the last stage', async () => {
      const otherLoopBlocker = await create('Other loop', { loopId: 'loop-2', stage: 'todo' });
      await ticket('Waits', { dependencies: [otherLoopBlocker.id] });
      await ticket('Done already', { stage: 'done' });
      await ticket('Busy', { status: 'in_progress' });
      await ticket('Theirs', { userId: OTHER_USER });
      const next = await ticket('Next');

      expect((await workItemRepository.findNextReadyForLoop(USER, LOOP, 'done'))?.id).toBe(next.id);

      await workItemRepository.updateForUser(otherLoopBlocker.id, USER, { status: 'closed' });
      expect((await workItemRepository.findNextReadyForLoop(USER, LOOP, 'done'))?.title).toBe('Waits');
    });

    it('claimForRun wins once; releaseClaim reopens and unlinks', async () => {
      const t = await ticket('T');
      expect(await workItemRepository.claimForRun(t.id)).toMatchObject({ status: 'in_progress' });
      expect(await workItemRepository.claimForRun(t.id)).toBeNull();

      await workItemRepository.setExecution(t.id, 'exec-1');
      expect((await workItemRepository.findByExecutionId('exec-1'))?.id).toBe(t.id);

      await workItemRepository.releaseClaim(t.id);
      const released = await workItemRepository.findByIdForUser(t.id, USER);
      expect(released).toMatchObject({ status: 'open' });
      expect(released?.executionId).toBeUndefined();
    });

    it('foldTicketRun applies only while the ticket is in_progress under that run', async () => {
      const t = await ticket('T', { status: 'in_progress', executionId: 'exec-1' });
      expect(await workItemRepository.foldTicketRun(t.id, 'exec-2', { status: 'open' })).toBe(false);
      expect(
        await workItemRepository.foldTicketRun(t.id, 'exec-1', { stage: 'doing', status: 'open', statusReason: null })
      ).toBe(true);
      expect(await workItemRepository.foldTicketRun(t.id, 'exec-1', { status: 'blocked' })).toBe(false);

      // A run that blocked its own ticket is not overwritten by the fold.
      const selfBlocked = await ticket('S', { status: 'blocked', statusReason: 'stuck', executionId: 'exec-3' });
      expect(await workItemRepository.foldTicketRun(selfBlocked.id, 'exec-3', { status: 'open' })).toBe(false);
      expect(await workItemRepository.findByIdForUser(selfBlocked.id, USER)).toMatchObject({ status: 'blocked' });
    });

    it('listForLoop returns every open ticket and only the newest closed ones', async () => {
      await ticket('Open');
      await ticket('Old', { stage: 'done', status: 'closed', closedAt: new Date(1000) });
      await ticket('New', { stage: 'done', status: 'closed', closedAt: new Date(2000) });

      const listed = await workItemRepository.listForLoop(USER, LOOP, 1);
      expect(listed.map(item => item.title)).toEqual(['Open', 'New']);
    });

    it("softDeleteByLoop removes only that loop's tickets", async () => {
      await ticket('A');
      await create('Other loop', { loopId: 'loop-2' });
      await create('Plain');

      expect(await workItemRepository.softDeleteByLoop(USER, LOOP)).toBe(1);
      expect(await workItemRepository.findNextReadyForLoop(USER, LOOP, 'done')).toBeNull();
    });
  });
});
