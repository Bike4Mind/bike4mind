import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import type { IAttachmentDelivery } from '@bike4mind/common';
import { createMongoServer } from '../../__test__/createMongoServer';
import { Quest, questRepository } from './QuestModel';

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
  await Quest.deleteMany({}, { hardDelete: true } as Record<string, unknown>);
});

const makeQuest = (overrides: Record<string, unknown> = {}) =>
  Quest.create({
    sessionId: 'session-1',
    type: 'message',
    timestamp: new Date(),
    prompt: 'hello',
    ...overrides,
  });

const fullDelivery: IAttachmentDelivery = {
  requested: 3,
  delivered: 2,
  fullyDelivered: 1,
  dropped: 1,
  droppedIds: ['file-a', 'file-b'],
};

// Fresh read from the DB, not the in-memory doc a write just returned - the whole point of this
// suite is to catch a schema path that Mongoose accepts on write but silently drops on the way in.
const readRaw = async (id: string) => Quest.collection.findOne({ _id: new mongoose.Types.ObjectId(id) });

describe('Quest.attachmentDelivery persistence', () => {
  it('round-trips every sub-field through a real write and a fresh read', async () => {
    const quest = await makeQuest({ attachmentDelivery: fullDelivery });

    const raw = await readRaw(quest._id.toString());

    // Deep equality against the literal covers every sub-field and its type: a dropped path reads
    // back as undefined, and a mis-declared droppedIds reads back as something other than an array.
    expect(raw?.attachmentDelivery).toEqual(fullDelivery);
  });
});

describe('QuestRepository.recordAttachmentOutcomeByAgentExecutionId', () => {
  it('writes both attachmentNotices and attachmentDelivery when notices are non-empty', async () => {
    const quest = await makeQuest({ agentExecutionId: 'exec-1' });

    await questRepository.recordAttachmentOutcomeByAgentExecutionId('exec-1', {
      notices: ['file-b could not be delivered'],
      delivery: fullDelivery,
    });

    const raw = await readRaw(quest._id.toString());

    expect(raw?.attachmentNotices).toEqual(['file-b could not be delivered']);
    expect(raw?.attachmentDelivery).toEqual(fullDelivery);
  });

  it('writes attachmentDelivery but leaves a pre-set attachmentNotices untouched when notices is empty', async () => {
    const quest = await makeQuest({
      agentExecutionId: 'exec-2',
      attachmentNotices: ['earlier writer left this notice'],
    });

    await questRepository.recordAttachmentOutcomeByAgentExecutionId('exec-2', {
      notices: [],
      delivery: fullDelivery,
    });

    const raw = await readRaw(quest._id.toString());

    expect(raw?.attachmentNotices).toEqual(['earlier writer left this notice']);
    expect(raw?.attachmentDelivery).toEqual(fullDelivery);
  });

  it('is a silent no-op when no quest matches the agentExecutionId', async () => {
    await expect(
      questRepository.recordAttachmentOutcomeByAgentExecutionId('no-such-execution', {
        notices: [],
        delivery: fullDelivery,
      })
    ).resolves.not.toThrow();
  });
});
