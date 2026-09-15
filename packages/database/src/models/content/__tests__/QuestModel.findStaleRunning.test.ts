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

  /** `updatedAt` is maintained by mongoose timestamps, so backdating needs a raw collection write. */
  const backdate = async (id: string, agoMs: number) => {
    await Quest.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(id) },
      { $set: { updatedAt: new Date(Date.now() - agoMs) } }
    );
  };

  const cutoff = () => new Date(Date.now() - 120_000);

  it('returns quests stuck at running whose updatedAt is older than the cutoff', async () => {
    const stale = await questRepository.create(makeQuest());
    await backdate(stale.id, 300_000);

    const results = await questRepository.findStaleRunning({ olderThan: cutoff() });

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe(stale.id);
  });

  it('excludes fresh running quests (heartbeat still alive)', async () => {
    await questRepository.create(makeQuest()); // updatedAt = now (fresh)

    const results = await questRepository.findStaleRunning({ olderThan: cutoff() });

    expect(results).toHaveLength(0);
  });

  it('excludes already-terminal quests even if old', async () => {
    const done = await questRepository.create(makeQuest({ status: 'done' }));
    await backdate(done.id, 300_000);

    const results = await questRepository.findStaleRunning({ olderThan: cutoff() });

    expect(results).toHaveLength(0);
  });

  it('respects the limit parameter', async () => {
    const q1 = await questRepository.create(makeQuest());
    const q2 = await questRepository.create(makeQuest());
    await backdate(q1.id, 300_000);
    await backdate(q2.id, 300_000);

    const results = await questRepository.findStaleRunning({ olderThan: cutoff(), limit: 1 });

    expect(results).toHaveLength(1);
  });

  it('excludes quests older than the newerThan floor', async () => {
    const withinFloor = await questRepository.create(makeQuest());
    const beyondFloor = await questRepository.create(makeQuest());
    await backdate(withinFloor.id, 300_000);
    await backdate(beyondFloor.id, 30 * 24 * 60 * 60 * 1000);

    const results = await questRepository.findStaleRunning({
      olderThan: cutoff(),
      newerThan: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
    });

    // The floor is what keeps a steady-state sweep from rewriting the historical backlog.
    expect(results.map(r => r.id)).toEqual([withinFloor.id]);
  });

  it('returns the oldest candidates first, so a capped run drains the worst backlog', async () => {
    const newer = await questRepository.create(makeQuest());
    const older = await questRepository.create(makeQuest());
    await backdate(newer.id, 200_000);
    await backdate(older.id, 600_000);

    const results = await questRepository.findStaleRunning({ olderThan: cutoff() });

    expect(results.map(r => r.id)).toEqual([older.id, newer.id]);
  });

  it('projects exactly the fields the recovery decision reads, and no more', async () => {
    const stale = await questRepository.create(
      makeQuest({
        reply: 'partial',
        replies: ['partial'],
        images: ['img.png'],
        videos: ['clip.mp4'],
        structuredReplies: [{ role: 'assistant', content: [{ type: 'text', text: 'from a tool' }] }],
        toolResults: [{ tool_use_id: 'call_1', content: 'tool output' }],
      })
    );
    await backdate(stale.id, 300_000);

    const results = await questRepository.findStaleRunning({ olderThan: cutoff() });

    expect(results).toHaveLength(1);
    const [quest] = results;

    // An exact key set, not toMatchObject: subset-matching stays green with the projection
    // deleted entirely, and it is silence about a MISSING content field that stamps a timeout
    // error over work the user can see. `_id` must be gone - callers get `id` only.
    expect(Object.keys(quest).sort()).toEqual(
      ['id', 'images', 'reply', 'replies', 'status', 'structuredReplies', 'toolResults', 'updatedAt', 'videos'].sort()
    );

    expect(quest.id).toBe(stale.id);
    expect(quest.status).toBe('running');
    expect(quest.reply).toBe('partial');
    expect(quest.replies).toEqual(['partial']);
    expect(quest.images).toEqual(['img.png']);
    expect(quest.videos).toEqual(['clip.mp4']);
    expect(quest.structuredReplies?.[0]?.content?.[0]).toMatchObject({ text: 'from a tool' });
    expect(quest.toolResults?.[0]).toMatchObject({ content: 'tool output' });
    expect(quest.updatedAt).toBeInstanceOf(Date);
  });
});
