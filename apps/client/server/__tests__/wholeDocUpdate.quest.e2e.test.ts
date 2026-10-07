/**
 * Real-Mongo regression for the converted quest status writes (see wholeDocUpdate.money.e2e.test.ts
 * for the hazard). A quest is written by several parties at once - the streaming pipeline, image and
 * tool writers, soft delete - so a status write carrying the whole read-time quest put back fields
 * another writer had just set. Drives QuestMasterFeature's status + error-path writes against a quest
 * that a concurrent writer changed after the in-memory copy was read.
 *
 * Consumes the built dist (`pnpm turbo:core:build`); integration lane only.
 */
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import { Quest, questRepository } from '@bike4mind/database';
import { QuestMasterFeature, type ChatCompletionContext } from '@bike4mind/services/llm';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

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
  await Quest.deleteMany({}, { hardDelete: true });
});

const questOid = (id: string) => ({ _id: new mongoose.Types.ObjectId(id) });

/** Seeds a quest and returns the in-memory copy a feature would hold, read BEFORE `concurrent` runs. */
async function readThenRace(concurrent: (id: string) => Promise<unknown>) {
  const created = await Quest.create({
    sessionId: 'session1',
    prompt: 'plan my week',
    type: 'message',
    timestamp: new Date(),
  });
  const id = String(created._id);
  const quest = await questRepository.findById(id);
  await concurrent(id);
  return quest!;
}

type InMemoryQuest = Awaited<ReturnType<typeof readThenRace>>;

/** Mirrors StatusManager.sendStatusUpdate: appends to the in-memory statusLog, persists nothing. */
const sendStatusUpdate = vi.fn(async (quest: InMemoryQuest, status: string | null) => {
  if (status) quest.promptMeta?.statusLog?.push({ status, timestamp: new Date() });
});

function newFeature() {
  return new QuestMasterFeature({
    user: { id: 'user1' },
    db: { quests: questRepository },
    logger: { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), updateMetadata: vi.fn() },
    sendStatusUpdate,
  } as unknown as ChatCompletionContext);
}

function runFeature(feature: QuestMasterFeature, quest: InMemoryQuest) {
  return feature.beforeDataGathering({
    quest,
    session: { id: 'session1' },
    startParams: {},
    llm: {},
    model: 'test-model',
    modelInfo: { id: 'test-model', contextWindow: 200_000, max_tokens: 16384, type: 'text' },
    message: 'plan my week',
    historyCount: 10,
    fabFileIds: [],
    questId: quest.id,
    questMaster: undefined,
  } as never);
}

/** Runs QuestMasterFeature to its error path: status=running write, then the error write. */
async function runToErrorPath(quest: InMemoryQuest) {
  const feature = newFeature();
  vi.spyOn(feature as never, 'sendQuestMasterRapidReply').mockRejectedValue(new Error('planner unavailable') as never);
  expect(await runFeature(feature, quest)).toEqual({ shouldContinue: true });
}

describe('quest: QuestMasterFeature status writes', () => {
  it('keep a quest field another writer set after the in-memory read', async () => {
    const quest = await readThenRace(id =>
      Quest.updateOne({ _id: id }, { $set: { images: ['generated.png'], replies: ['streamed'] } })
    );

    await runToErrorPath(quest);

    const after = await Quest.findById(quest.id).lean();
    expect(after?.images).toEqual(['generated.png']);
    expect(after?.replies).toEqual(['streamed']);
    expect(after?.type).toBe('error');
    expect(after?.status).toBe('done');
    expect(after?.reply).toBe('planner unavailable');
  });

  it('persist the in-memory statusLog on a QuestMaster takeover, which skips the pipeline saveQuest', async () => {
    const quest = await readThenRace(async () => undefined);
    quest.promptMeta = { statusLog: [{ status: 'Spinning up...', timestamp: new Date() }] } as typeof quest.promptMeta;
    const feature = newFeature();
    vi.spyOn(feature as never, 'sendQuestMasterRapidReply').mockResolvedValue(undefined as never);
    vi.spyOn(feature as never, 'questMasterRequest').mockResolvedValue(undefined as never);

    expect(await runFeature(feature, quest)).toEqual({ shouldContinue: false });

    const after = await Quest.findById(quest.id).lean();
    expect(after?.status).toBe('done');
    expect(after?.promptMeta?.statusLog?.map(entry => entry.status)).toEqual([
      'Spinning up...',
      'QuestMaster plan generated',
    ]);
  });

  it('does not resurrect a quest soft-deleted after the in-memory read (guards the soft-delete update filter)', async () => {
    const deletedAt = new Date();
    const quest = await readThenRace(id => Quest.collection.updateOne(questOid(id), { $set: { deletedAt } }));

    await runToErrorPath(quest);

    // Raw collection read: the soft-delete plugin hides deleted rows from model finds.
    const after = await Quest.collection.findOne(questOid(quest.id));
    expect(after?.deletedAt).toEqual(deletedAt);
  });
});
