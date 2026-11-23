// @vitest-environment node
/**
 * The pending-decisions count against real Mongo: only the caller's live notebooks count, only inside the
 * window the pending-actions endpoints still accept an answer in, and a brief's approval decisions never
 * add to it.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import { AssistantBriefModel, Quest, Session, assistantBriefRepository } from '@bike4mind/database';
import { countPendingDecisions } from './countPendingDecisions';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
  await Quest.syncIndexes();
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});
afterEach(async () => {
  await mongoose.connection.dropDatabase();
});

const NOW = 1_800_000_000_000;
const WINDOW_MS = 15 * 60 * 1000;

const notebook = async (userId: string, fields: Record<string, unknown> = {}) =>
  (await Session.create({ name: 'n', userId, lastUpdated: new Date(), firstCreated: new Date(), ...fields })).id;
const parkedQuest = (sessionId: string, ts: number) =>
  Quest.collection.insertOne({
    sessionId,
    timestamp: new Date(),
    deletedAt: null,
    pendingAction: { tool: 't', params: {}, ts },
  });

describe('countPendingDecisions (real Mongo)', () => {
  it("counts only the caller's live notebooks, inside the answer window", async () => {
    const mine = await notebook('owner');
    const theirs = await notebook('someone-else');
    const deleted = await notebook('owner', { deletedAt: new Date() });
    await parkedQuest(mine, NOW - WINDOW_MS);
    await parkedQuest(mine, NOW - 1);
    await parkedQuest(mine, NOW - WINDOW_MS - 1);
    await parkedQuest(theirs, NOW - 1);
    await parkedQuest(deleted, NOW - 1);

    await expect(countPendingDecisions('owner', NOW)).resolves.toEqual({
      count: 2,
      approvals: 2,
      briefDecisions: 0,
      briefId: null,
    });
    await expect(countPendingDecisions('someone-else', NOW)).resolves.toMatchObject({ approvals: 1 });
    await expect(countPendingDecisions('nobody', NOW)).resolves.toMatchObject({ count: 0 });
  });

  it("adds the latest ready brief's non-approval decisions, once", async () => {
    await AssistantBriefModel.init();
    const mine = await notebook('owner');
    await parkedQuest(mine, NOW - 1);
    const brief = await assistantBriefRepository.createComposing({
      userId: 'owner',
      periodStart: new Date(NOW),
      periodEnd: new Date(NOW),
    });
    await assistantBriefRepository.markReady(
      String(brief._id),
      {
        headline: 'Brief',
        happened: [],
        handled: [],
        decisions: [
          { id: 'd1', text: 'Reply to the vendor' },
          {
            id: 'd2',
            text: 'Approve the deploy',
            approval: { questId: 'q', sessionId: mine, pendingActionTs: NOW - 1 },
          },
        ],
      },
      new Date(NOW)
    );

    await expect(countPendingDecisions('owner', NOW)).resolves.toEqual({
      count: 2,
      approvals: 1,
      briefDecisions: 1,
      briefId: String(brief._id),
    });
  });
});
