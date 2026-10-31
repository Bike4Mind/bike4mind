import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import type { IChatHistoryItemDocument } from '@bike4mind/common';
import { createMongoServer } from '../../../__test__/createMongoServer';
import { Quest, questRepository } from '../QuestModel';

/**
 * The chat pipeline's mid-turn saves (streaming heartbeat, tools, research mode) write the changed
 * fields of an in-memory quest whose status is 'running'. This is the interleaving a user Stop has to survive:
 * stopReply writes 'stopped', a save lands, then the cancellation watcher polls the status.
 */
describe('QuestModel.updateIfUnfinished', () => {
  let mongoServer: MongoMemoryServer;

  beforeEach(async () => {
    mongoServer = await createMongoServer();
    await mongoose.connect(mongoServer.getUri());
  });

  afterEach(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  const createRunningQuest = async () => {
    const created = await questRepository.create({
      sessionId: 'session-a',
      type: 'message',
      timestamp: new Date(),
      prompt: 'hello',
      status: 'running',
    });
    return (await questRepository.findById(created.id)) as IChatHistoryItemDocument;
  };

  it('does not resurrect a Stop written just before the save', async () => {
    const inMemory = await createRunningQuest();
    inMemory.replies = ['partial answer'];

    await Quest.findOneAndUpdate({ _id: inMemory.id, status: { $nin: ['done', 'stopped'] } }, { status: 'stopped' });
    const saved = await questRepository.updateIfUnfinished(inMemory);
    const watcherPoll = await questRepository.findByIdWithStatus(inMemory.id);

    expect(saved).toBeNull();
    expect(watcherPoll?.status).toBe('stopped');
  });

  it('does not overwrite a quest that already finished', async () => {
    const inMemory = await createRunningQuest();
    await Quest.updateOne({ _id: inMemory.id }, { status: 'done', reply: 'the real answer' });

    expect(await questRepository.updateIfUnfinished({ ...inMemory, reply: 'stale' })).toBeNull();
    expect((await Quest.findById(inMemory.id))?.reply).toBe('the real answer');
  });

  it('persists the whole quest while it is still running', async () => {
    const inMemory = await createRunningQuest();
    inMemory.replies = ['partial answer'];

    const saved = await questRepository.updateIfUnfinished(inMemory);

    expect(saved?.status).toBe('running');
    expect(saved?.replies).toEqual(['partial answer']);
  });

  it('refreshes updatedAt on a save with no changed fields', async () => {
    const inMemory = await createRunningQuest();
    const before = (await Quest.findById(inMemory.id))!.updatedAt as Date;
    await new Promise(resolve => setTimeout(resolve, 5));

    const saved = await questRepository.updateIfUnfinished({ id: inMemory.id });

    expect(saved?.status).toBe('running');
    expect((await Quest.findById(inMemory.id))!.updatedAt.getTime()).toBeGreaterThan(before.getTime());
  });

  it('does not write to a quest soft-deleted before the save', async () => {
    const inMemory = await createRunningQuest();
    await Quest.updateOne({ _id: inMemory.id }, { deletedAt: new Date() });

    expect(await questRepository.updateIfUnfinished({ id: inMemory.id, replies: ['late'] })).toBeNull();
    const stored = await Quest.findById(inMemory.id).setOptions({ includeDeleted: true });
    expect(stored?.deletedAt).toBeInstanceOf(Date);
    expect(stored?.replies).toEqual([]);
  });
});
