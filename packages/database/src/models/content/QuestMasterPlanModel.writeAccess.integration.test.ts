import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../__test__/createMongoServer';
import { QuestMasterPlan, questMasterPlanRepository as repo } from './QuestMasterPlanModel';

/**
 * Real-MongoDB coverage for the write-time re-check on every sharee-reachable plan write: owner or
 * sharedWith and not soft-deleted are in the write filter, so a revoke or delete that lands after
 * the route's access check turns the write into a no-op. Mirrors
 * SessionModel.updateWithUpdateAccess.integration.test.ts.
 */

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let server: Awaited<ReturnType<typeof createMongoServer>>;

const OWNER = 'owner';
const SHAREE = 'sharee';

const seed = async () => {
  const plan = await QuestMasterPlan.create({
    notebookId: 'clone-placeholder',
    userId: OWNER,
    sharedWith: [SHAREE],
    goal: 'Ship it',
    state: 'active',
    quests: [
      {
        id: 'q1',
        title: 'Quest',
        description: 'd',
        complexity: 'Medium',
        subQuests: [{ id: 'sq1', title: 'Sub', status: 'not_started' }],
      },
    ],
    blockers: [{ id: 'b1', description: 'stuck', createdAt: new Date() }],
  });
  return String(plan._id);
};

const raw = (id: string) => QuestMasterPlan.collection.findOne({ _id: new mongoose.Types.ObjectId(id) });

// Each gated writer, called as `userId`. A refused write resolves null/false (or rejects, for the
// two that throw); `applied` reads back whether it landed.
const writers: [
  string,
  (id: string, userId: string) => Promise<unknown>,
  (doc: Awaited<ReturnType<typeof raw>>) => boolean,
][] = [
  [
    'updateTaskStatus',
    (id, u) => repo.updateTaskStatus(id, u, 'q1', 'sq1', 'completed'),
    d => d!.quests[0].subQuests[0].status === 'completed',
  ],
  [
    'updateQuestProgress',
    (id, u) => repo.updateQuestProgress(id, u, 'q1', 'sq1', { evidence: 'proof' }),
    d => d!.quests[0].subQuests[0].evidence === 'proof',
  ],
  [
    'continueInSession',
    (id, u) => {
      // Its own findById refuses a revoked or deleted plan first; hand it the pre-revoke read so the
      // write filter is what refuses.
      vi.spyOn(repo, 'findById').mockResolvedValueOnce({ userId: OWNER, sharedWith: [SHAREE] } as never);
      return repo.continueInSession(id, 'session-1', u);
    },
    d => (d!.sessionHistory ?? []).length === 1,
  ],
  [
    'resumeIfPaused',
    async (id, u) => {
      await QuestMasterPlan.collection.updateOne(
        { _id: new mongoose.Types.ObjectId(id) },
        { $set: { state: 'paused' } }
      );
      return repo.resumeIfPaused(id, u);
    },
    d => d!.state === 'active',
  ],
  [
    'atomicUpdateNotebookId',
    (id, u) => repo.atomicUpdateNotebookId(id, u, 'clone-placeholder', 'session-1'),
    d => d!.notebookId === 'session-1',
  ],
  [
    'updateHandoff',
    (id, u) =>
      repo.updateHandoff(id, u, {
        summary: 's',
        nextSteps: [],
        pendingDecisions: [],
        blockers: [],
        lastUpdatedBy: u,
        updatedAt: new Date(),
      }),
    d => d!.handoff?.summary === 's',
  ],
  [
    'addBlocker',
    (id, u) => repo.addBlocker(id, u, { id: 'b2', description: 'new', createdAt: new Date() }),
    d => d!.blockers.length === 2,
  ],
  ['resolveBlocker', (id, u) => repo.resolveBlocker(id, u, 'b1', 'fixed'), d => d!.blockers[0].resolution === 'fixed'],
  [
    'addDecision',
    (id, u) => repo.addDecision(id, u, { id: 'd1', description: 'x', rationale: 'y', madeBy: u, madeAt: new Date() }),
    d => (d!.decisions ?? []).length === 1,
  ],
  [
    'updateReviewGate',
    (id, u) => repo.updateReviewGate(id, u, 'q1', 'sq1', 'approved'),
    d => d!.quests[0].subQuests[0].reviewStatus === 'approved',
  ],
];

// A refusal is a falsy result or a rejection; either way nothing may be written.
const refused = async (write: () => Promise<unknown>) => {
  try {
    return !(await write());
  } catch {
    return true;
  }
};

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

afterEach(async () => {
  // Let the fire-and-forget metrics recompute a successful progress write schedules settle first.
  await new Promise(resolve => setTimeout(resolve, 50));
  vi.restoreAllMocks();
  await QuestMasterPlan.collection.deleteMany({});
});

describe('QuestMasterPlanRepository write-time access re-check', () => {
  describe.each(writers)('%s', (_name, write, applied) => {
    it.each([
      ['owner', OWNER],
      ['sharee', SHAREE],
    ])('writes for the %s', async (_label, userId) => {
      const id = await seed();

      await write(id, userId);

      expect(applied(await raw(id))).toBe(true);
    });

    it('writes nothing for a user the plan is no longer shared with', async () => {
      const id = await seed();
      await QuestMasterPlan.collection.updateOne(
        { _id: new mongoose.Types.ObjectId(id) },
        { $set: { sharedWith: [] } }
      );

      expect(await refused(() => write(id, SHAREE))).toBe(true);
      expect(applied(await raw(id))).toBe(false);
    });

    it('writes nothing on a soft-deleted plan, even for the owner', async () => {
      const id = await seed();
      await QuestMasterPlan.collection.updateOne(
        { _id: new mongoose.Types.ObjectId(id) },
        { $set: { deletedAt: new Date() } }
      );

      expect(await refused(() => write(id, OWNER))).toBe(true);
      expect(applied(await raw(id))).toBe(false);
    });
  });

  it('resumeIfPaused leaves a plan that is not paused alone', async () => {
    const id = await seed();
    await QuestMasterPlan.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(id) },
      { $set: { state: 'archived' } }
    );

    expect(await repo.resumeIfPaused(id, OWNER)).toBeNull();
    expect((await raw(id))!.state).toBe('archived');
  });
});
