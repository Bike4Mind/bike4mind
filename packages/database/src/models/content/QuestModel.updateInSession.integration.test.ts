import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../__test__/createMongoServer';
import { Quest, questRepository } from './QuestModel';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

beforeEach(async () => {
  await Quest.collection.deleteMany({});
});

const seed = async (over: Record<string, unknown> = {}) => {
  const quest = await Quest.create({
    sessionId: 'session-1',
    type: 'chat',
    timestamp: new Date(),
    reply: 'old',
    ...over,
  });
  return String(quest._id);
};

const raw = (id: string) => Quest.collection.findOne({ _id: new mongoose.Types.ObjectId(id) });

describe('questRepository.updateInSession', () => {
  it('updates a live quest in its own session', async () => {
    const id = await seed();

    expect(await questRepository.updateInSession('session-1', { id, reply: 'new' })).not.toBeNull();
    expect((await raw(id))!.reply).toBe('new');
  });

  it("does not land on another session's quest", async () => {
    const id = await seed();

    expect(await questRepository.updateInSession('session-2', { id, reply: 'new' })).toBeNull();
    expect((await raw(id))!.reply).toBe('old');
  });

  it('does not write to a soft-deleted quest', async () => {
    const id = await seed({ deletedAt: new Date() });

    expect(await questRepository.updateInSession('session-1', { id, reply: 'new' })).toBeNull();
    expect((await raw(id))!.reply).toBe('old');
  });
});
