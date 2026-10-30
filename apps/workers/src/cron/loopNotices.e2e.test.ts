import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import { adminSettingsRepository, Inbox, Loop, WorkItem, workItemRepository } from '@bike4mind/database';
import type { Logger } from '@bike4mind/observability';

/**
 * Real-Mongo tests for the loop notice sweep, driven through the scheduler tick so the
 * EnableLoops gate is covered too. Seeded loops are never due, so the tick dispatches nothing.
 */

vi.mock('sst', () => ({ Resource: { App: { stage: 'test' } } }));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: {} }));
vi.mock('@server/utils/startAgentExecution', () => ({ startAgentExecution: vi.fn() }));

import { runLoopSchedulerTick } from './loopScheduler';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
const NOW = new Date('2026-10-29T12:00:00Z');
let loopsEnabled: boolean;

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
  await Inbox.syncIndexes();
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});
beforeEach(() => {
  loopsEnabled = true;
  vi.spyOn(adminSettingsRepository, 'getSettingsValue').mockImplementation(
    (async (key: string) => key === 'EnableLoops' && loopsEnabled) as never
  );
});
afterEach(async () => {
  await Promise.all([Loop.deleteMany({}), WorkItem.deleteMany({}), Inbox.collection.deleteMany({})]);
  vi.restoreAllMocks();
});

const createLoop = async (overrides: Record<string, unknown> = {}) =>
  (
    await Loop.create({
      userId: 'owner-1',
      name: 'Digest',
      goal: 'Summarize the inbox',
      model: 'claude-sonnet-5',
      sessionId: 'session-1',
      intervalMinutes: 15,
      tools: [],
      status: 'paused',
      ...overrides,
    })
  ).toJSON();

const blockedTicket = async (loopId: string, overrides: Record<string, unknown> = {}) =>
  (
    await WorkItem.create({
      userId: 'owner-1',
      loopId,
      stage: 'todo',
      title: 'Approve the spend',
      status: 'blocked',
      statusReason: 'needs a yes',
      dependencies: [],
      ...overrides,
    })
  ).toJSON();

const tick = () => runLoopSchedulerTick(NOW, logger);
const openNotices = () => Inbox.find({ deletedAt: null }).lean();

describe('loop notices', () => {
  it.each([
    ['paused', 'Out of credits', 'paused'],
    ['needs_you', 'The notebook is gone', 'needs you'],
    ['error', 'Run failed 3 times', 'stopped with an error'],
  ])('opens one notice for a %s loop with a reason', async (status, statusReason, phrase) => {
    const loop = await createLoop({ status, statusReason });
    await tick();
    await tick();

    const notices = await openNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      userId: 'SYSTEM',
      receiverId: 'owner-1',
      type: 'loop',
      sourceKey: `loop:${loop.id}:status:${status}`,
      link: `/loops/${loop.id}`,
      title: `Loop "Digest" ${phrase}`,
    });
    expect(notices[0].message).toContain(statusReason);
  });

  it('stays silent for an owner pause, a live loop and a draft', async () => {
    await createLoop({ status: 'paused' });
    await createLoop({ status: 'live', nextRunAt: new Date(NOW.getTime() + 60_000) });
    await createLoop({ status: 'draft' });
    await tick();
    expect(await openNotices()).toHaveLength(0);
  });

  it('writes nothing with EnableLoops off', async () => {
    loopsEnabled = false;
    const loop = await createLoop({ status: 'error', statusReason: 'x' });
    await blockedTicket(loop.id);
    await tick();
    expect(await Inbox.countDocuments({})).toBe(0);
  });

  it('opens one notice per blocked ticket, linking its run when it has one', async () => {
    const loop = await createLoop({ status: 'live', nextRunAt: new Date(NOW.getTime() + 60_000) });
    const plain = await blockedTicket(loop.id);
    const ran = await blockedTicket(loop.id, { executionId: 'exec-9', title: 'Log in' });
    await tick();
    await tick();

    const notices = await openNotices();
    expect(notices).toHaveLength(2);
    const byKey = Object.fromEntries(notices.map(n => [n.sourceKey, n]));
    expect(byKey[`loop:${loop.id}:ticket:${plain.id}`]).toMatchObject({
      link: `/loops/${loop.id}`,
      title: 'Loop "Digest": ticket blocked - Approve the spend',
    });
    expect(byKey[`loop:${loop.id}:ticket:${plain.id}`].message).toContain('needs a yes');
    expect(byKey[`loop:${loop.id}:ticket:${ran.id}`].link).toBe(`/loops/${loop.id}?run=exec-9`);
  });

  it('resolves the notice when the loop goes live again, and reopens on recurrence', async () => {
    const loop = await createLoop({ status: 'paused', statusReason: 'Out of credits' });
    await tick();
    await Loop.updateOne(
      { _id: loop.id },
      { $set: { status: 'live', nextRunAt: new Date(NOW.getTime() + 60_000) }, $unset: { statusReason: '' } }
    );
    await tick();
    expect(await openNotices()).toHaveLength(0);

    await Loop.updateOne({ _id: loop.id }, { $set: { status: 'paused', statusReason: 'Out of credits' } });
    await tick();
    expect(await openNotices()).toHaveLength(1);
    expect(await Inbox.collection.countDocuments({})).toBe(2);
  });

  it('replaces the notice when the status changes', async () => {
    const loop = await createLoop({ status: 'paused', statusReason: 'Out of credits' });
    await tick();
    await Loop.updateOne({ _id: loop.id }, { $set: { status: 'error', statusReason: 'Run failed' } });
    await tick();
    expect((await openNotices()).map(n => n.sourceKey)).toEqual([`loop:${loop.id}:status:error`]);
  });

  it('resolves ticket notices on unblock, close, ticket delete and loop delete', async () => {
    const loop = await createLoop({ status: 'live', nextRunAt: new Date(NOW.getTime() + 60_000) });
    const other = await createLoop({ status: 'live', nextRunAt: new Date(NOW.getTime() + 60_000) });
    const unblocked = await blockedTicket(loop.id);
    const closed = await blockedTicket(loop.id);
    const deleted = await blockedTicket(loop.id);
    await blockedTicket(other.id);
    await tick();
    expect(await openNotices()).toHaveLength(4);

    await WorkItem.updateOne({ _id: unblocked.id }, { $set: { status: 'open' }, $unset: { statusReason: '' } });
    await WorkItem.updateOne({ _id: closed.id }, { $set: { status: 'closed', stage: 'done' } });
    await workItemRepository.softDeleteForUser(deleted.id, 'owner-1');
    await Loop.deleteOne({ _id: other.id });
    await tick();
    expect(await openNotices()).toHaveLength(0);
  });
});
