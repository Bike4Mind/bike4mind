import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QuestMasterFeature } from './ChatCompletionFeatures';
import type { IChatHistoryItemDocument } from '@bike4mind/common';

// Regression guard for the object-level authz fix: QuestMaster plan/quest/sub-quest ids arrive
// from client-supplied `questMaster` params, so `onComplete` must not mutate a plan the caller
// does not own or share. `updateTaskStatus` is the mutation we assert on.

const CALLER = 'user-A';
const OTHER = 'user-B';
// A legacy plan's notebookId is a real session _id, so it must be ObjectId-shaped: the plan-write
// guard skips the notebook lookup for a non-ObjectId value (placeholder plans carry a userId).
const NB = '650000000000000000000abc';

const questMaster = { questMasterPlanId: 'plan1', questId: 'q1', subQuestId: 'sq1' };

const makeHarness = () => {
  const updateTaskStatus = vi.fn().mockResolvedValue(undefined);
  const findById = vi.fn();
  const sessionsFindById = vi.fn();

  const chatCompletion = {
    logger: { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    user: { id: CALLER },
    db: {
      questMasterPlans: { findById, updateTaskStatus },
      sessions: { findById: sessionsFindById },
    },
  };

  // Constructor only reads logger + user; the cast keeps the heavy ChatCompletionContext off the test.
  const feature = new QuestMasterFeature(
    chatCompletion as unknown as ConstructorParameters<typeof QuestMasterFeature>[0]
  );
  return { feature, findById, updateTaskStatus, sessionsFindById };
};

const call = (feature: QuestMasterFeature) =>
  feature.onComplete({
    quest: { id: 'quest1', sessionId: 'session1' } as unknown as IChatHistoryItemDocument,
    questMaster: questMaster as never,
  });

describe('QuestMasterFeature.onComplete plan access guard', () => {
  beforeEach(() => vi.clearAllMocks());

  it('marks the sub-quest complete when the caller owns the plan', async () => {
    const { feature, findById, updateTaskStatus } = makeHarness();
    findById.mockResolvedValueOnce({ id: 'plan1', userId: CALLER, quests: [{ id: 'q1' }] });

    await call(feature);

    expect(updateTaskStatus).toHaveBeenCalledWith('plan1', 'q1', 'sq1', 'completed');
  });

  it('marks the sub-quest complete when the plan is shared with the caller', async () => {
    const { feature, findById, updateTaskStatus } = makeHarness();
    findById.mockResolvedValueOnce({ id: 'plan1', userId: OTHER, sharedWith: [CALLER], quests: [{ id: 'q1' }] });

    await call(feature);

    expect(updateTaskStatus).toHaveBeenCalledWith('plan1', 'q1', 'sq1', 'completed');
  });

  it('refuses to mutate a plan owned by another user', async () => {
    const { feature, findById, updateTaskStatus } = makeHarness();
    findById.mockResolvedValueOnce({ id: 'plan1', userId: OTHER, quests: [{ id: 'q1' }] });

    await call(feature);

    expect(updateTaskStatus).not.toHaveBeenCalled();
  });

  it('binds a legacy plan (no userId) to its notebook owner - allows when the caller owns it', async () => {
    const { feature, findById, updateTaskStatus, sessionsFindById } = makeHarness();
    findById.mockResolvedValueOnce({ id: 'plan1', notebookId: NB, quests: [{ id: 'q1' }] });
    sessionsFindById.mockResolvedValueOnce({ id: NB, userId: CALLER });

    await call(feature);

    expect(sessionsFindById).toHaveBeenCalledWith(NB);
    expect(updateTaskStatus).toHaveBeenCalledWith('plan1', 'q1', 'sq1', 'completed');
  });

  it('binds a legacy plan (no userId) to its notebook owner - refuses a foreign notebook', async () => {
    const { feature, findById, updateTaskStatus, sessionsFindById } = makeHarness();
    findById.mockResolvedValueOnce({ id: 'plan1', notebookId: NB, quests: [{ id: 'q1' }] });
    sessionsFindById.mockResolvedValueOnce({ id: NB, userId: OTHER });

    await call(feature);

    expect(updateTaskStatus).not.toHaveBeenCalled();
  });

  it('refuses a legacy plan whose notebookId is not ObjectId-shaped, without a session lookup', async () => {
    const { feature, findById, updateTaskStatus, sessionsFindById } = makeHarness();
    findById.mockResolvedValueOnce({ id: 'plan1', notebookId: 'direct-abc', quests: [{ id: 'q1' }] });

    await call(feature);

    expect(sessionsFindById).not.toHaveBeenCalled();
    expect(updateTaskStatus).not.toHaveBeenCalled();
  });
});
