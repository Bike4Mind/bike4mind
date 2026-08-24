import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoServer } from '../../../__test__/createMongoServer';
import { Quest, questRepository } from '../QuestModel';

/**
 * Every caller-side test of this method fully mocks `questRepository`, so none
 * of them exercises the real `$nin` filter or the projection. This is the one
 * test that runs the actual query against real Mongo: a typo that let `done`
 * through, or a content field dropped from the projection, would otherwise pass
 * CI clean and only show up as a settled bubble stamped with a false error.
 */
describe('QuestModel.findUnfinishedByAgentExecutionIds', () => {
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
    agentExecutionId: 'exec-1',
    ...overrides,
  });

  it('returns a quest still claiming to be in flight', async () => {
    const quest = await questRepository.create(makeQuest({ status: 'pending' }));

    const found = await questRepository.findUnfinishedByAgentExecutionIds(['exec-1']);

    expect(found.map(q => q.id)).toEqual([quest.id]);
  });

  it('excludes terminal quests so a natural completion wins the race', async () => {
    await questRepository.create(makeQuest({ status: 'done' }));
    await questRepository.create(makeQuest({ status: 'stopped' }));

    expect(await questRepository.findUnfinishedByAgentExecutionIds(['exec-1'])).toEqual([]);
  });

  it('returns a running quest - only done and stopped are terminal', async () => {
    await questRepository.create(makeQuest({ status: 'running' }));

    expect(await questRepository.findUnfinishedByAgentExecutionIds(['exec-1'])).toHaveLength(1);
  });

  it('treats a quest with no status at all as unfinished', async () => {
    // $nin matches missing fields, and a quest that died before any status
    // write is exactly the stranded case this exists for.
    await questRepository.create(makeQuest({}));

    expect(await questRepository.findUnfinishedByAgentExecutionIds(['exec-1'])).toHaveLength(1);
  });

  it('scopes to the requested executions only', async () => {
    await questRepository.create(makeQuest({ status: 'pending', agentExecutionId: 'exec-other' }));

    expect(await questRepository.findUnfinishedByAgentExecutionIds(['exec-1'])).toEqual([]);
  });

  it('matches across several executions in one call', async () => {
    await questRepository.create(makeQuest({ status: 'pending', agentExecutionId: 'exec-1' }));
    await questRepository.create(makeQuest({ status: 'pending', agentExecutionId: 'exec-2' }));

    const found = await questRepository.findUnfinishedByAgentExecutionIds(['exec-1', 'exec-2']);

    expect(found).toHaveLength(2);
  });

  it('projects every content field the terminal-patch decision reads', async () => {
    // The projection is hand-listed, so a field the decision reads but the query
    // omits reads as absent and turns a partially-successful run into an error.
    await questRepository.create(
      makeQuest({
        status: 'pending',
        reply: 'partial',
        replies: ['a'],
        images: ['i.png'],
        videos: ['v.mp4'],
        structuredReplies: [{ role: 'assistant', content: [{ type: 'text', text: 'x' }] }],
        toolResults: [{ type: 'tool_result', tool_use_id: 't1', content: 'out' }],
      })
    );

    const [found] = await questRepository.findUnfinishedByAgentExecutionIds(['exec-1']);

    expect(found.reply).toBe('partial');
    expect(found.replies).toEqual(['a']);
    expect(found.images).toEqual(['i.png']);
    expect(found.videos).toEqual(['v.mp4']);
    expect(found.structuredReplies).toHaveLength(1);
    expect(found.toolResults).toHaveLength(1);
  });

  it('is a no-op on an empty id list rather than matching everything', async () => {
    await questRepository.create(makeQuest({ status: 'pending' }));

    expect(await questRepository.findUnfinishedByAgentExecutionIds([])).toEqual([]);
  });
});
