import { describe, it, expect, vi } from 'vitest';
import mongoose from 'mongoose';
import type { IDataLakeResearchRun, ResearchRunLevers } from '@bike4mind/common';
import { emptyResearchRunTotals, RESEARCH_RUN_STALE_AFTER_MS } from '@bike4mind/common';
import { DataLakeResearchRunModel, dataLakeResearchRunRepository as repo } from './DataLakeResearchRunModel';
import { setupMongoTest } from '../../__test__/utils';

const LAKE = 'lake-1';

const levers = (overrides: Partial<ResearchRunLevers> = {}): ResearchRunLevers => ({
  query: 'coastal erosion',
  maxResults: 10,
  maxProposals: 5,
  allowedDomains: [],
  blockedDomains: [],
  minRelevance: 0.6,
  costCeilingMicroUsd: 50_000,
  proposedTags: [],
  ...overrides,
});

type CreateInput = Omit<IDataLakeResearchRun, 'status' | 'spentMicroUsd' | 'totals'>;

const input = (overrides: Partial<CreateInput> = {}): CreateInput => ({
  dataLakeId: LAKE,
  configId: 'config-1',
  levers: levers(),
  trigger: 'on_demand',
  startedByUserId: 'user-1',
  startedAt: null,
  completedAt: null,
  ...overrides,
});

/** Advance the wall clock past `createdAt`'s millisecond resolution. */
const tick = () => new Promise(resolve => setTimeout(resolve, 5));

/**
 * Age a run row by `ms`. Straight through the native driver on purpose: Mongoose ignores
 * `timestamps: false` on an update, so a model-level write would leave `createdAt` where it was.
 */
const backdate = async (id: string, ms: number) => {
  const past = new Date(Date.now() - ms);
  await mongoose
    .model('DataLakeResearchRun')
    .collection.updateOne({ _id: new mongoose.Types.ObjectId(id) }, { $set: { createdAt: past, startedAt: past } });
};

describe('DataLakeResearchRunRepository', () => {
  setupMongoTest();

  it('creates a run queued, unstarted and unspent, whatever a caller hoped for', async () => {
    const created = await repo.createRun(input());

    expect(created).toMatchObject({ status: 'queued', spentMicroUsd: 0, startedAt: null, completedAt: null });
    expect(created.totals).toMatchObject(emptyResearchRunTotals());
    expect(created.stopReason).toBeNull();
  });

  it('snapshots the levers it was started with', async () => {
    const created = await repo.createRun(input({ levers: levers({ recencyDays: 30, model: 'gpt-4.1-mini' }) }));

    const reread = await repo.findByIdInLake(created.id, LAKE);

    expect(reread?.levers).toMatchObject({ query: 'coastal erosion', recencyDays: 30, model: 'gpt-4.1-mini' });
  });

  it('lists one lake newest first, honoring a limit, and never another lake', async () => {
    // Spaced out: `createdAt` has millisecond resolution, and three inserts inside one millisecond
    // would make the sort this test is about unordered.
    await repo.createRun(input({ configId: 'oldest' }));
    await tick();
    await repo.createRun(input({ configId: 'middle' }));
    await tick();
    await repo.createRun(input({ configId: 'newest' }));
    await repo.createRun(input({ dataLakeId: 'lake-2', configId: 'other' }));

    expect((await repo.listByLake(LAKE)).map(r => r.configId)).toEqual(['newest', 'middle', 'oldest']);
    expect((await repo.listByLake(LAKE, { limit: 2 })).map(r => r.configId)).toEqual(['newest', 'middle']);
  });

  it('will not read a run through another lake id', async () => {
    const created = await repo.createRun(input());
    expect(await repo.findByIdInLake(created.id, 'lake-2')).toBeNull();
  });

  it('answers null on a junk id rather than throwing', async () => {
    expect(await repo.findByIdInLake('not-an-object-id', LAKE)).toBeNull();
    expect(await repo.claimForExecution('not-an-object-id', new Date())).toBeNull();
  });

  // The other half of that: a junk id is an ANSWER (no such row, on every redelivery), a database
  // fault is not. Null on a fault would tell the handler the work was already done, it would return
  // successfully, SQS would delete the message, and the row would sit `queued` forever holding the
  // one-at-a-time guard shut with nothing left to redeliver it.
  it('lets a database fault propagate out of the claim instead of reporting it as "not queued"', async () => {
    const boom = new Error('connection timed out');
    const spy = vi.spyOn(DataLakeResearchRunModel, 'findOneAndUpdate').mockRejectedValueOnce(boom as never);

    await expect(repo.claimForExecution(new mongoose.Types.ObjectId().toString(), new Date())).rejects.toThrow(
      /connection timed out/
    );

    spy.mockRestore();
  });

  // The at-least-once guard. SQS redelivers, and a second pass over the loop would not merely write
  // a duplicate - it would spend a second cost ceiling.
  describe('claimForExecution', () => {
    it('claims a queued run exactly once', async () => {
      const created = await repo.createRun(input());
      const startedAt = new Date('2026-03-01T12:00:00.000Z');

      const first = await repo.claimForExecution(created.id, startedAt);
      const second = await repo.claimForExecution(created.id, new Date());

      expect(first).toMatchObject({ status: 'running', startedAt });
      expect(second).toBeNull();
    });

    it('refuses to re-claim a settled run', async () => {
      const created = await repo.createRun(input());
      await repo.settleRun(created.id, {
        status: 'completed',
        completedAt: new Date(),
        spentMicroUsd: 0,
        totals: emptyResearchRunTotals(),
      });

      expect(await repo.claimForExecution(created.id, new Date())).toBeNull();
    });
  });

  it('settles a run with its stop reason, spend and totals', async () => {
    const created = await repo.createRun(input());
    const completedAt = new Date('2026-03-01T12:05:00.000Z');

    await repo.settleRun(created.id, {
      status: 'completed',
      completedAt,
      stopReason: 'proposal_limit',
      spentMicroUsd: 1_234,
      totals: { ...emptyResearchRunTotals(), searchHits: 10, proposed: 5 },
    });

    expect(await repo.findByIdInLake(created.id, LAKE)).toMatchObject({
      status: 'completed',
      completedAt,
      stopReason: 'proposal_limit',
      spentMicroUsd: 1_234,
      error: null,
      totals: expect.objectContaining({ searchHits: 10, proposed: 5 }),
    });
  });

  it('settles a failure with its message and no stop reason', async () => {
    const created = await repo.createRun(input());

    await repo.settleRun(created.id, {
      status: 'failed',
      completedAt: new Date(),
      spentMicroUsd: 42,
      totals: emptyResearchRunTotals(),
      error: 'No web search provider is configured',
    });

    const settled = await repo.findByIdInLake(created.id, LAKE);
    expect(settled).toMatchObject({ status: 'failed', error: 'No web search provider is configured' });
    // The spend is kept: a failed run that already paid for judgments still paid for them.
    expect(settled?.spentMicroUsd).toBe(42);
    expect(settled?.stopReason).toBeNull();
  });

  it('records mid-run progress without settling the run', async () => {
    const created = await repo.createRun(input());
    await repo.claimForExecution(created.id, new Date());

    await repo.recordProgress(created.id, 500, { ...emptyResearchRunTotals(), proposed: 1 });

    const mid = await repo.findByIdInLake(created.id, LAKE);
    expect(mid).toMatchObject({ status: 'running', spentMicroUsd: 500 });
    expect(mid?.totals.proposed).toBe(1);
  });

  describe('the guards a start checks', () => {
    it('counts queued and running as active, and nothing else', async () => {
      const queued = await repo.createRun(input());
      expect(await repo.countActiveByLake(LAKE)).toBe(1);

      await repo.claimForExecution(queued.id, new Date());
      expect(await repo.countActiveByLake(LAKE)).toBe(1);

      await repo.settleRun(queued.id, {
        status: 'completed',
        completedAt: new Date(),
        spentMicroUsd: 0,
        totals: emptyResearchRunTotals(),
      });
      expect(await repo.countActiveByLake(LAKE)).toBe(0);
    });

    // The lockout this bound exists to prevent: a hard Lambda timeout, an OOM or a replaced
    // container leaves `running` behind with no catch ever executing, and nothing reaps it. Without
    // an age bound that lake could never start another run - no cancel endpoint, no reaper, no
    // admin path back.
    it('stops counting a run that has been abandoned past the stale window', async () => {
      const created = await repo.createRun(input());
      await repo.claimForExecution(created.id, new Date());
      expect(await repo.countActiveByLake(LAKE)).toBe(1);

      // Backdated through the native driver: Mongoose ignores `timestamps: false` on updateOne, so
      // going through the model would refuse to move `createdAt`.
      await backdate(created.id, RESEARCH_RUN_STALE_AFTER_MS + 60_000);

      expect(await repo.countActiveByLake(LAKE)).toBe(0);
    });

    it('stops counting a queued run whose message never arrived', async () => {
      const created = await repo.createRun(input());
      await backdate(created.id, RESEARCH_RUN_STALE_AFTER_MS + 60_000);

      expect(await repo.countActiveByLake(LAKE)).toBe(0);
    });

    it('scopes the active count to one lake', async () => {
      await repo.createRun(input({ dataLakeId: 'lake-2' }));
      expect(await repo.countActiveByLake(LAKE)).toBe(0);
    });

    it('counts only runs started inside the window', async () => {
      await repo.createRun(input());

      expect(await repo.countStartedSince(LAKE, new Date(Date.now() - 60_000))).toBe(1);
      expect(await repo.countStartedSince(LAKE, new Date(Date.now() + 60_000))).toBe(0);
      expect(await repo.countStartedSince('lake-2', new Date(Date.now() - 60_000))).toBe(0);
    });
  });

  it('sweeps only the named lake on delete', async () => {
    await repo.createRun(input());
    await repo.createRun(input());
    await repo.createRun(input({ dataLakeId: 'lake-2' }));

    expect(await repo.deleteForLake(LAKE)).toBe(2);
    expect(await repo.listByLake(LAKE)).toHaveLength(0);
    expect(await repo.listByLake('lake-2')).toHaveLength(1);
  });
});
