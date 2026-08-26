import { SUBQUEST_STATUS_VALUES } from '@bike4mind/common';
import mongoose from 'mongoose';
import { describe, expect, it } from 'vitest';
import { QuestMasterPlan, questMasterPlanRepository } from '../models/content/QuestMasterPlanModel';
import { setupMongoTest } from './utils';

/**
 * Characterization of what a NON-CANONICAL sub-quest status on disk actually does.
 *
 * This is reachable because the mongoose `enum` on the status path is only enforced on the
 * create path: there is no `runValidators` anywhere in QuestMasterPlanModel and every status
 * write is `findOneAndUpdate` + `$set` (same write-path asymmetry pinned for Quest.promptMeta in
 * questPromptMetaSessionPersistence.test.ts). Anything that reached the collection before the
 * vocabulary was unified therefore survives untouched, and no read path validates.
 *
 * The legacy tokens below are the retired vocabularies, not invented ones: `pending` /
 * `in-progress` came from the V2 artifact zod schema, and `blocked` from the deleted V1
 * repository interface.
 */
describe('QuestMasterPlan legacy sub-quest status on disk', () => {
  setupMongoTest();

  const rawCollection = () => {
    const db = mongoose.connection.db;
    if (!db) throw new Error('no connection');
    return db.collection('questmasterplans');
  };

  const seedLegacyPlan = async () => {
    const plan = await QuestMasterPlan.create({
      notebookId: 'session1',
      userId: new mongoose.Types.ObjectId().toString(),
      goal: 'Ship the thing',
      state: 'active',
      quests: [
        {
          id: 'q1',
          title: 'Quest one',
          description: 'First quest',
          complexity: 'Medium',
          subQuests: [
            { id: 'sq1', title: 'Canonical completed', status: 'completed' },
            { id: 'sq2', title: 'Will become legacy hyphen', status: 'in_progress' },
            { id: 'sq3', title: 'Will become legacy pending', status: 'not_started' },
            { id: 'sq4', title: 'Will become legacy blocked', status: 'skipped' },
          ],
        },
      ],
    });

    // Raw $set - no schema, no validators. This is exactly the shape the update path can
    // produce, and the only way legacy data can be sitting in the collection today.
    await rawCollection().updateOne(
      { _id: plan._id },
      {
        $set: {
          'quests.0.subQuests.1.status': 'in-progress',
          'quests.0.subQuests.2.status': 'pending',
          'quests.0.subQuests.3.status': 'blocked',
        },
      }
    );

    return plan._id.toString();
  };

  it('confirms the collection name this migration has to target', async () => {
    await seedLegacyPlan();
    const names = (await mongoose.connection.db!.listCollections().toArray()).map(c => c.name);

    expect(names).toContain('questmasterplans');
  });

  it('accepts a non-canonical status through a raw $set - the enum never runs', async () => {
    const planId = await seedLegacyPlan();
    const raw = await rawCollection().findOne({ _id: new mongoose.Types.ObjectId(planId) });
    const statuses = (raw!.quests as { subQuests: { status: string }[] }[])[0].subQuests.map(sq => sq.status);

    expect(statuses).toEqual(['completed', 'in-progress', 'pending', 'blocked']);
    expect(statuses.filter(s => !(SUBQUEST_STATUS_VALUES as readonly string[]).includes(s))).toHaveLength(3);
  });

  it('hands legacy statuses straight through to every reader, unvalidated', async () => {
    const planId = await seedLegacyPlan();
    const plan = await questMasterPlanRepository.findById(planId);
    const statuses = plan!.quests[0].subQuests.map(sq => sq.status);

    // No read-time coercion anywhere: what the API returns to the client, what the docx export
    // formats, and what the UI chip renders is the raw legacy token.
    expect(statuses).toEqual(['completed', 'in-progress', 'pending', 'blocked']);
  });

  it('miscounts nothing in metrics - completed is spelled identically in both vocabularies', async () => {
    const planId = await seedLegacyPlan();
    const updated = await questMasterPlanRepository.updateMetrics(planId);

    // The aggregation only ever compares against 'completed', so legacy tokens cannot corrupt
    // the completion rate. This is the one read path that is immune, and it is worth pinning:
    // it means a migration cannot change any user-visible metric.
    expect(updated!.metrics?.subQuestsTotal).toBe(4);
    expect(updated!.metrics?.subQuestsCompleted).toBe(1);
    expect(updated!.metrics?.completionRate).toBe(25);
  });

  it('still refuses a non-canonical status through the validated repository path', async () => {
    const planId = await seedLegacyPlan();

    await expect(
      questMasterPlanRepository.updateQuestProgress(planId, 'q1', 'sq1', {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- forcing the runtime guard past the compile-time type is the point
        status: 'in-progress' as any,
      })
    ).rejects.toThrow('Invalid status: in-progress');
  });

  it('now refuses a retired token at the SCHEMA, on the writer that has no explicit guard', async () => {
    const planId = await seedLegacyPlan();

    // updateTaskStatus carries no hand-rolled vocabulary check - the schema enum is its only
    // gate, and it is only a gate because runValidators is on. This is the test that would go
    // green again if someone removed that option.
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- forcing past the compile-time type is the point
      questMasterPlanRepository.updateTaskStatus(planId, 'q1', 'sq1', 'in-progress' as any)
    ).rejects.toThrow(/not a valid enum value/);

    // And the rejected write left the stored value alone rather than half-applying.
    const raw = await rawCollection().findOne({ _id: new mongoose.Types.ObjectId(planId) });
    expect((raw!.quests as { subQuests: { status: string }[] }[])[0].subQuests[0].status).toBe('completed');
  });

  it('refuses a bad review-gate status at the schema too - the only writer of that field', async () => {
    const planId = await seedLegacyPlan();

    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- forcing past the compile-time type is the point
      questMasterPlanRepository.updateReviewGate(planId, 'q1', 'sq1', 'not-a-review-status' as any)
    ).rejects.toThrow(/not a valid enum value/);
  });

  it('still accepts a valid review-gate status', async () => {
    const planId = await seedLegacyPlan();

    const updated = await questMasterPlanRepository.updateReviewGate(planId, 'q1', 'sq1', 'approved', 'looks good');

    expect(updated!.quests[0].subQuests[0].reviewStatus).toBe('approved');
    expect(updated!.quests[0].subQuests[0].reviewNote).toBe('looks good');
  });

  it('lets a legacy sub-quest be written back to a canonical status', async () => {
    const planId = await seedLegacyPlan();

    // The repair path a user exercises by clicking the sub-quest: a legacy row is not stuck,
    // because the write validator gates the incoming value, not the stored one.
    const updated = await questMasterPlanRepository.updateQuestProgress(planId, 'q1', 'sq2', {
      status: 'in_progress',
    });

    expect(updated!.quests[0].subQuests[1].status).toBe('in_progress');
  });
});
