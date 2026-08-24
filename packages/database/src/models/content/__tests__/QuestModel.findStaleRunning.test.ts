import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoServer } from '../../../__test__/createMongoServer';
import { Quest, questRepository } from '../QuestModel';

describe('QuestModel.findStaleRunning', () => {
  let mongoServer: MongoMemoryServer;

  beforeEach(async () => {
    mongoServer = await createMongoServer();
    await mongoose.connect(mongoServer.getUri());
    await Quest.createIndexes();
  });

  afterEach(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  const makeQuest = (overrides: Record<string, unknown> = {}) => ({
    sessionId: 'session-a',
    type: 'message',
    timestamp: new Date(),
    prompt: 'hello',
    status: 'running',
    ...overrides,
  });

  it('returns quests stuck at running whose updatedAt is older than the cutoff', async () => {
    const stale = await questRepository.create(makeQuest());
    // Backdate updatedAt so it qualifies as stale.
    const longAgo = new Date(Date.now() - 300_000);
    await Quest.collection.updateOne({ _id: new mongoose.Types.ObjectId(stale.id) }, { $set: { updatedAt: longAgo } });

    const cutoff = new Date(Date.now() - 120_000);
    const results = await questRepository.findStaleRunning({ olderThan: cutoff });

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe(stale.id);
  });

  it('excludes fresh running quests (heartbeat still alive)', async () => {
    await questRepository.create(makeQuest()); // updatedAt = now (fresh)

    const cutoff = new Date(Date.now() - 120_000);
    const results = await questRepository.findStaleRunning({ olderThan: cutoff });

    expect(results).toHaveLength(0);
  });

  it('excludes already-terminal quests even if old', async () => {
    const done = await questRepository.create(makeQuest({ status: 'done' }));
    const longAgo = new Date(Date.now() - 300_000);
    await Quest.collection.updateOne({ _id: new mongoose.Types.ObjectId(done.id) }, { $set: { updatedAt: longAgo } });

    const cutoff = new Date(Date.now() - 120_000);
    const results = await questRepository.findStaleRunning({ olderThan: cutoff });

    expect(results).toHaveLength(0);
  });

  it('respects the limit parameter', async () => {
    const longAgo = new Date(Date.now() - 300_000);
    const q1 = await questRepository.create(makeQuest());
    const q2 = await questRepository.create(makeQuest());
    await Quest.collection.updateOne({ _id: new mongoose.Types.ObjectId(q1.id) }, { $set: { updatedAt: longAgo } });
    await Quest.collection.updateOne({ _id: new mongoose.Types.ObjectId(q2.id) }, { $set: { updatedAt: longAgo } });

    const cutoff = new Date(Date.now() - 120_000);
    const results = await questRepository.findStaleRunning({ olderThan: cutoff, limit: 1 });

    expect(results).toHaveLength(1);
  });

  it('projects the fields needed for timeout recovery', async () => {
    const stale = await questRepository.create(
      makeQuest({ reply: 'partial', replies: ['partial'], images: ['img.png'] })
    );
    const longAgo = new Date(Date.now() - 300_000);
    await Quest.collection.updateOne({ _id: new mongoose.Types.ObjectId(stale.id) }, { $set: { updatedAt: longAgo } });

    const cutoff = new Date(Date.now() - 120_000);
    const results = await questRepository.findStaleRunning({ olderThan: cutoff });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      id: stale.id,
      status: 'running',
      reply: 'partial',
      replies: ['partial'],
      images: ['img.png'],
    });
    expect(results[0].updatedAt).toBeDefined();
  });
});
