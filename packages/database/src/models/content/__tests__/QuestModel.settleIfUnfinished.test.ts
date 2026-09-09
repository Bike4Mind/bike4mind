import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoServer } from '../../../__test__/createMongoServer';
import { Quest, questRepository } from '../QuestModel';

/**
 * The atomic half of the settle pass. Every caller-side test mocks the
 * repository, so this is the only place the status predicate meets real Mongo:
 * a write that lost the guard would still pass CI and would stamp the
 * abandoned-run error over an answer that had just landed.
 */
describe('QuestModel.settleIfUnfinished', () => {
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

  const ABANDONED = { status: 'done' as const, type: 'error' as const, reply: 'abandoned' };

  const makeQuest = (overrides: Record<string, unknown> = {}) => ({
    sessionId: 'session-a',
    type: 'message',
    timestamp: new Date(),
    prompt: 'hello',
    agentExecutionId: 'exec-1',
    ...overrides,
  });

  it('patches a quest that is still unfinished and reports the write', async () => {
    const quest = await questRepository.create(makeQuest({ status: 'pending' }));

    expect(await questRepository.settleIfUnfinished(quest.id, ABANDONED)).toBe(true);

    const after = await Quest.findById(quest.id);
    expect(after?.status).toBe('done');
    expect(after?.type).toBe('error');
    expect(after?.reply).toBe('abandoned');
  });

  it('refuses a quest that finished first, and leaves its answer alone', async () => {
    // The race the predicate exists for: the settle pass read this quest as
    // unfinished, then `persistRunAsQuest` landed the real answer before the
    // write. An `_id`-only update would replace it with the error text.
    const quest = await questRepository.create(makeQuest({ status: 'done', reply: 'the real answer' }));

    expect(await questRepository.settleIfUnfinished(quest.id, ABANDONED)).toBe(false);

    const after = await Quest.findById(quest.id);
    expect(after?.reply).toBe('the real answer');
    expect(after?.type).toBe('message');
  });

  it('refuses a stopped quest - the user already ended that run', async () => {
    const quest = await questRepository.create(makeQuest({ status: 'stopped' }));

    expect(await questRepository.settleIfUnfinished(quest.id, ABANDONED)).toBe(false);
    expect((await Quest.findById(quest.id))?.status).toBe('stopped');
  });

  it('settles a quest that never got a status at all', async () => {
    // A run that died before any status write is exactly the stranded case, and
    // $nin matches a missing field.
    const quest = await questRepository.create(makeQuest({}));

    expect(await questRepository.settleIfUnfinished(quest.id, ABANDONED)).toBe(true);
    expect((await Quest.findById(quest.id))?.status).toBe('done');
  });

  it('reports false rather than throwing when the quest is gone', async () => {
    const missing = new mongoose.Types.ObjectId().toString();

    expect(await questRepository.settleIfUnfinished(missing, ABANDONED)).toBe(false);
  });
});
