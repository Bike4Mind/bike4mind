import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';

// The one collaborator the retry path reaches out of process for. Everything else - the schemas,
// the access check, and the quest repository under test - stays real.
vi.mock('@bike4mind/llm-adapters', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/llm-adapters')>()),
  getAvailableModels: vi.fn().mockResolvedValue([{ id: 'test-model', disabled: false }]),
}));

const { questRepository } = await import('@bike4mind/database');
const { ChatCompletionInvoke } = await import('@bike4mind/services/llm');

/**
 * The retry write, end to end: a real ChatCompletionInvoke against the real quest repository and a
 * real mongod, re-reading the document afterwards.
 *
 * The mocked-repository test in b4m-core/services pins the ARGUMENT the call site passes, which is
 * exactly the assertion that cannot see the defect this covers: `q` is a plain object, so
 * `q.errorCode = undefined` leaves the key present with an undefined value, `$set` treats that as an
 * absence, and the stale `insufficient_credits` survives on disk. Only a re-read can tell the two
 * apart, and only against a real server - no repository mock reproduces the driver's rule.
 *
 * Lives in apps/client because it is the only package that can see @bike4mind/services and
 * @bike4mind/database at once, and it consumes their built dist, so `pnpm turbo:core:build` must be
 * current.
 */

// Boots a real mongod, so lift the whole file off the shard's unit-test budget for tests AND hooks
// (see MONGO_TEST_TIMEOUT_MS for why 30s is not enough).
vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const USER_ID = new mongoose.Types.ObjectId().toString();
const SESSION_ID = new mongoose.Types.ObjectId().toString();

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
  await mongoose.connection.dropDatabase();
});

const makeInvoke = () => {
  const invokeLambda = vi.fn().mockResolvedValue(undefined);
  const db = {
    quests: questRepository,
    sessions: {
      findById: vi.fn().mockResolvedValue({ id: SESSION_ID, userId: USER_ID, agentIds: [] }),
      update: vi.fn().mockResolvedValue(undefined),
    },
    organizations: { findById: vi.fn().mockResolvedValue(null) },
    apiKeys: { findByUserIdAndTypes: vi.fn().mockResolvedValue([]) },
    adminSettings: {
      getSettingsValue: vi.fn().mockResolvedValue('text-embedding-3-small'),
      findOne: vi.fn().mockResolvedValue({ settingValue: [] }),
      findBySettingNames: vi.fn().mockResolvedValue([]),
      findAll: vi.fn().mockResolvedValue([]),
    },
  };

  const invoke = new ChatCompletionInvoke({
    db,
    logger: { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    user: { id: USER_ID, isAdmin: false, tags: [] },
    invokeLambda,
  } as unknown as ConstructorParameters<typeof ChatCompletionInvoke>[0]);

  return { invoke, invokeLambda };
};

/** A quest as a credit-exhaustion failure leaves it on disk, ready to be retried. */
const seedFailedQuest = () =>
  questRepository.create({
    sessionId: SESSION_ID,
    type: 'error',
    timestamp: new Date(),
    prompt: 'first attempt',
    reply: 'You have run out of credits.',
    status: 'done',
    errorCode: 'insufficient_credits',
  } as Parameters<typeof questRepository.create>[0]);

describe('retrying a credit-exhausted quest', () => {
  it('removes the stale errorCode from the stored document, not just the in-memory copy', async () => {
    const seeded = await seedFailedQuest();
    expect(
      await mongoose.connection.collection('quests').findOne({ _id: new mongoose.Types.ObjectId(seeded.id) })
    ).toHaveProperty('errorCode', 'insufficient_credits');

    const { invoke, invokeLambda } = makeInvoke();
    const returned = await invoke.invoke({
      body: {
        sessionId: SESSION_ID,
        questId: seeded.id,
        message: 'retry this',
        historyCount: 0,
        fabFileIds: [],
        params: { model: 'test-model' },
      } as never,
      userId: USER_ID,
    });

    expect(invokeLambda).toHaveBeenCalledOnce();
    // The caller reads the returned local object, so the in-memory clear matters on its own.
    expect(returned?.errorCode).toBeUndefined();

    // Read through the driver, not the repository: `toJSON` would flatten an absent field and a
    // stored `undefined` to the same thing, which is the distinction under test.
    const stored = await mongoose.connection.collection('quests').findOne({
      _id: new mongoose.Types.ObjectId(seeded.id),
    });
    expect(stored).not.toHaveProperty('errorCode');
    // The rest of the retry reset still landed, so this is not passing on a write that never ran.
    expect(stored).toMatchObject({ type: 'message', status: 'running', prompt: 'retry this' });
  });
});
