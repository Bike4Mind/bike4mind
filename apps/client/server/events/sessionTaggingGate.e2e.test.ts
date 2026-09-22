import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';

/**
 * Closes the seam between "the handler stamps `taggedAt`" and "the spider then skips the
 * notebook". Both halves are covered on their own and neither can catch a break in the join:
 *
 * - `SessionModel.taggedAt.integration.test.ts` proves a HAND-BUILT `taggedAt` survives a strict-
 *   mode write to a real mongod.
 * - `spider.test.ts` proves `determineSessionOperations` returns `tags: false` for a MOCKED
 *   session document that carries one.
 *
 * Nothing ran the real handler against real Mongo and fed what came back to the real gate, so
 * "the second run skips" was asserted as two disconnected halves - which is exactly how the
 * original defect hid: strict mode dropped the field between them, and both halves still passed.
 *
 * The same join is asserted for the credit pre-flight's counter: `countTaggableNotebooks` and the
 * handler's no-quest abort are two statements of one rule, and a comment is all that keeps them in
 * step. Here they are checked against the same real rows.
 *
 * Only the LLM, the usage settlement and the event wrappers are stubbed. The Session and Quest
 * models, the repository write and the gate are all real.
 *
 * Consumes the built dist, so `pnpm turbo:core:build` must be current.
 */

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const h = vi.hoisted(() => ({
  completionText: [] as string[],
}));

// spider.ts reads Resource at import time (same stub as spider.test.ts).
vi.mock('sst', () => ({
  Resource: new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (prop === 'App') return { stage: 'test' };
        if (prop === 'AppEventBus') return { name: 'mock-event-bus' };
        if (prop === 'websocket') return { managementEndpoint: 'mock-endpoint' };
        return { value: 'mock-value', name: 'mock-name' };
      },
    }
  ),
}));

// Passthrough so the raw handler runs without connectDB / Config; this test owns the connection.
vi.mock('@server/events/utils', () => ({ withEventContext: (fn: unknown) => fn }));

vi.mock('@server/utils/eventBus', () => ({
  SessionEvents: {
    Tag: { schema: { parse: (properties: unknown) => properties }, publish: vi.fn() },
    Summarize: { publish: vi.fn() },
  },
  SpiderEvents: { Start: { publish: vi.fn() } },
  NotebookCurationEvents: { Start: { publish: vi.fn() } },
}));

vi.mock('@client/services/operationsModelService', () => ({
  OperationsModelService: {
    getOperationsModel: async () => ({
      modelId: 'test-model',
      modelInfo: { name: 'Test Model', backend: 'test' },
      llm: {
        complete: async (
          _modelId: string,
          _messages: unknown,
          _options: unknown,
          onChunk: (chunk: string[]) => Promise<void>
        ) => {
          await onChunk(h.completionText);
        },
      },
    }),
  },
}));

vi.mock('@server/events/recordSessionOperationalUsage', () => ({
  recordSessionOperationalUsage: vi.fn(),
}));

import { TAG_RETRY_BACKOFF_MS } from '@bike4mind/common';
import { Session, Quest, User, sessionRepository } from '@bike4mind/database';
import { handler } from './sessionTagging';
import { determineSessionOperations } from './spider';

let mongoServer: MongoMemoryServer;

const OWNER = new mongoose.Types.ObjectId().toString();

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
  await User.create({ _id: OWNER, username: 'probe', email: 'probe@example.com', name: 'Probe' });
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});

afterEach(async () => {
  await Session.deleteMany({}, { hardDelete: true } as mongoose.QueryOptions);
  await Quest.deleteMany({}, { hardDelete: true } as mongoose.QueryOptions);
});

const insertSession = async () =>
  Session.create({ name: 'probe', userId: OWNER, lastUpdated: new Date(), firstCreated: new Date() });

const insertQuest = async (sessionId: string) =>
  Quest.create({ sessionId, timestamp: new Date(), type: 'chat', prompt: 'How do pulsars form?' });

const runTagging = async (sessionId: string) =>
  (handler as unknown as (event: unknown, logger: unknown) => Promise<void>)(
    { event: 'session.tag', properties: { sessionId, userId: OWNER } },
    { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), updateMetadata: vi.fn() }
  );

/** Reload through the reader the spider uses, then ask the real gate. */
const gateAfterReload = async (sessionId: string) => {
  const [reloaded] = await sessionRepository.find({ _id: new mongoose.Types.ObjectId(sessionId) });
  expect(reloaded).toBeDefined();
  return { session: reloaded, operations: determineSessionOperations(reloaded, ['tags']) };
};

describe('tagging handler -> persisted taggedAt -> spider gate', () => {
  it('closes the tags gate for the next run after a successful tagging', async () => {
    const session = await insertSession();
    await insertQuest(session.id);
    h.completionText = ['[{"name": "pulsars", "strength": 9}]'];

    expect((await gateAfterReload(session.id)).operations.tags).toBe(true);
    expect(await sessionRepository.countTaggableNotebooks(OWNER)).toBe(1);

    await runTagging(session.id);

    const { session: reloaded, operations } = await gateAfterReload(session.id);
    expect(reloaded.taggedAt).toBeInstanceOf(Date);
    expect(reloaded.tags).toEqual([{ name: 'pulsars', strength: 9 }]);
    expect(operations.tags).toBe(false);
    expect(await sessionRepository.countTaggableNotebooks(OWNER)).toBe(0);
  });

  // The completion was billed before the parse failed, so the notebook earns a backoff stamp -
  // but NOT a `taggedAt`, which would close the gate forever on a notebook that was never tagged.
  // Gate and counter are asserted together on the same real rows: they are two statements of one
  // rule, and this file exists because a comment is not enough to keep them in step.
  it('holds the tags gate shut for the backoff when the completion does not parse', async () => {
    const session = await insertSession();
    await insertQuest(session.id);
    h.completionText = ['I was unable to produce tags for this notebook.'];

    await runTagging(session.id);

    const { session: reloaded, operations } = await gateAfterReload(session.id);
    expect(reloaded.taggedAt).toBeFalsy();
    expect(reloaded.tagLastAttemptAt).toBeInstanceOf(Date);
    expect(operations.tags).toBe(false);
    expect(await sessionRepository.countTaggableNotebooks(OWNER)).toBe(0);
  });

  // Bounded, not abandoned. No operator or automated path clears `taggedAt` - only a user's own
  // import overwrite - so a terminal cap would strand the notebook; backdating the stamp past the
  // window proves the gate and the price reopen together, which is what makes a transient bad
  // completion recoverable.
  it('reopens the tags gate and the price once the backoff has elapsed', async () => {
    const session = await insertSession();
    await insertQuest(session.id);
    h.completionText = ['I was unable to produce tags for this notebook.'];

    await runTagging(session.id);
    await Session.collection.updateOne(
      { _id: session._id },
      { $set: { tagLastAttemptAt: new Date(Date.now() - TAG_RETRY_BACKOFF_MS - 60_000) } }
    );

    const { operations } = await gateAfterReload(session.id);
    expect(operations.tags).toBe(true);
    expect(await sessionRepository.countTaggableNotebooks(OWNER)).toBe(1);
  });

  // The case the pre-flight narrowing exists for. The notebook never reached the model, so it has
  // earned no stamp and stays eligible - but it settles nothing, so it must NOT be priced. That
  // the gate and the counter disagree here is the point: the gate prices dispatches, the counter
  // prices what can settle.
  it('leaves the tags gate open for a notebook with no quests, but does not price it', async () => {
    const session = await insertSession();

    await runTagging(session.id);

    const { session: reloaded, operations } = await gateAfterReload(session.id);
    expect(reloaded.taggedAt).toBeFalsy();
    expect(operations.tags).toBe(true);
    expect(await sessionRepository.countTaggableNotebooks(OWNER)).toBe(0);
  });
});
