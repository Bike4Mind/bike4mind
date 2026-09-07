import { describe, it, expect } from 'vitest';
import type { IDataLakeResearchRun, ResearchRunLevers } from '@bike4mind/common';
import { emptyResearchRunTotals } from '@bike4mind/common';
import { dataLakeResearchRunRepository as repo } from './DataLakeResearchRunModel';
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
