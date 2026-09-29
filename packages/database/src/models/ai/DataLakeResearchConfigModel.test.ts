import { describe, it, expect } from 'vitest';
import type { CreateDataLakeResearchConfigInput } from '@bike4mind/common';
import { RESEARCH_REVIEW_BACKLOG_LIMIT_DEFAULT } from '@bike4mind/common';
import { DataLakeResearchConfigModel, dataLakeResearchConfigRepository as repo } from './DataLakeResearchConfigModel';
import { setupMongoTest } from '../../__test__/utils';

const LAKE = 'lake-1';

const input = (overrides: Partial<CreateDataLakeResearchConfigInput> = {}): CreateDataLakeResearchConfigInput => ({
  dataLakeId: LAKE,
  name: 'Weekly sweep',
  trigger: 'on_demand',
  cadence: 'off',
  reviewBacklogLimit: 25,
  nextRunAt: null,
  createdByUserId: 'user-1',
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

/** Advance the wall clock past `createdAt`'s millisecond resolution. */
const tick = () => new Promise(resolve => setTimeout(resolve, 5));

describe('DataLakeResearchConfigRepository', () => {
  setupMongoTest();

  it('stores every lever and defaults the optional ones', async () => {
    const created = await repo.createConfig(input({ recencyDays: 30, model: 'gpt-4.1-mini' }));

    expect(created).toMatchObject({
      dataLakeId: LAKE,
      name: 'Weekly sweep',
      trigger: 'on_demand',
      query: 'coastal erosion',
      recencyDays: 30,
      model: 'gpt-4.1-mini',
      costCeilingMicroUsd: 50_000,
    });
    expect(created.lastRunAt).toBeNull();
  });

  it('lists one lake newest first, and never another lake', async () => {
    // Spaced out: `createdAt` has millisecond resolution, and two inserts inside one millisecond
    // would make the sort this test is about unordered.
    await repo.createConfig(input({ name: 'older' }));
    await tick();
    await repo.createConfig(input({ name: 'newer' }));
    await repo.createConfig(input({ dataLakeId: 'lake-2', name: 'other lake' }));

    const listed = await repo.listByLake(LAKE);

    expect(listed.map(c => c.name)).toEqual(['newer', 'older']);
  });

  describe('lake scoping', () => {
    it('will not read a config through another lake id', async () => {
      const created = await repo.createConfig(input());
      expect(await repo.findByIdInLake(created.id, 'lake-2')).toBeNull();
      expect(await repo.findByIdInLake(created.id, LAKE)).not.toBeNull();
    });

    it('will not update or delete through another lake id', async () => {
      const created = await repo.createConfig(input());

      expect(await repo.updateConfig(created.id, 'lake-2', { name: 'hijacked', lastUpdatedByUserId: 'u2' })).toBeNull();
      expect(await repo.deleteConfig(created.id, 'lake-2')).toBe(false);

      const still = await repo.findByIdInLake(created.id, LAKE);
      expect(still?.name).toBe('Weekly sweep');
    });
  });

  // findOne REJECTS on a non-ObjectId string, so without the catch a junk id is a 500 where the
  // honest answer is "no such config".
  it('answers null on a junk id rather than throwing', async () => {
    expect(await repo.findByIdInLake('not-an-object-id', LAKE)).toBeNull();
    expect(await repo.updateConfig('not-an-object-id', LAKE, { lastUpdatedByUserId: 'u' })).toBeNull();
    expect(await repo.deleteConfig('not-an-object-id', LAKE)).toBe(false);
  });

  it('applies a patch and records who made it', async () => {
    const created = await repo.createConfig(input({ recencyDays: 30 }));

    const updated = await repo.updateConfig(created.id, LAKE, {
      maxProposals: 3,
      lastUpdatedByUserId: 'user-2',
    });

    expect(updated).toMatchObject({ maxProposals: 3, lastUpdatedByUserId: 'user-2', recencyDays: 30 });
  });

  // The clearing case the service writes an explicit null for.
  it('clears recencyDays and model when the patch sets them null', async () => {
    const created = await repo.createConfig(input({ recencyDays: 30, model: 'gpt-4.1-mini' }));

    const updated = await repo.updateConfig(created.id, LAKE, {
      recencyDays: null,
      model: null,
      lastUpdatedByUserId: 'user-2',
    });

    expect(updated?.recencyDays).toBeNull();
    expect(updated?.model).toBeNull();
  });

  it('stamps lastRunAt', async () => {
    const created = await repo.createConfig(input());
    const at = new Date('2026-03-01T12:00:00.000Z');

    await repo.recordRunStarted(created.id, at);

    expect((await repo.findByIdInLake(created.id, LAKE))?.lastRunAt).toEqual(at);
  });

  it('swallows a stamp against a junk id rather than failing the run that just started', async () => {
    await expect(repo.recordRunStarted('not-an-object-id', new Date())).resolves.toBeUndefined();
  });

  it('sweeps only the named lake on delete', async () => {
    await repo.createConfig(input());
    await repo.createConfig(input());
    await repo.createConfig(input({ dataLakeId: 'lake-2' }));

    expect(await repo.deleteForLake(LAKE)).toBe(2);
    expect(await repo.listByLake(LAKE)).toHaveLength(0);
    expect(await repo.listByLake('lake-2')).toHaveLength(1);
  });

  describe('scheduling', () => {
    const NOW = new Date('2026-03-10T09:05:00.000Z');
    const LEASE = new Date('2026-03-10T09:20:00.000Z');
    const scheduled = (nextRunAt: Date, overrides: Partial<CreateDataLakeResearchConfigInput> = {}) =>
      repo.createConfig(input({ trigger: 'periodic', cadence: 'daily', nextRunAt, ...overrides }));

    // A config saved before scheduling existed has neither field on disk.
    it('reads a pre-scheduling config as unscheduled with the default review limit', async () => {
      const { cadence: _cadence, reviewBacklogLimit: _limit, nextRunAt: _next, ...legacyFields } = input();
      const { insertedId } = await DataLakeResearchConfigModel.collection.insertOne(legacyFields);
      const legacy = await repo.findByIdInLake(String(insertedId), LAKE);
      expect(legacy).toMatchObject({ cadence: 'off', reviewBacklogLimit: RESEARCH_REVIEW_BACKLOG_LIMIT_DEFAULT });
    });

    it('claims only due, scheduled configs, returning each as it was before the claim', async () => {
      const due = await scheduled(new Date('2026-03-10T09:00:00.000Z'));
      await scheduled(new Date('2026-03-10T10:00:00.000Z'));
      // `off` with a stray nextRunAt must never fire.
      await scheduled(new Date('2026-03-10T08:00:00.000Z'), { cadence: 'off', trigger: 'on_demand' });

      const claimed = await repo.claimDueConfigs(NOW, LEASE, 10);

      expect(claimed.map(c => c.id)).toEqual([due.id]);
      expect(claimed[0].nextRunAt).toEqual(new Date('2026-03-10T09:00:00.000Z'));
      expect((await repo.findByIdInLake(due.id, LAKE))?.nextRunAt).toEqual(LEASE);
    });

    // The lease is what stops two overlapping ticks from both starting the same config.
    it('does not hand a claimed config to a second tick while its lease holds', async () => {
      await scheduled(new Date('2026-03-10T09:00:00.000Z'));

      expect(await repo.claimDueConfigs(NOW, LEASE, 10)).toHaveLength(1);
      expect(await repo.claimDueConfigs(NOW, LEASE, 10)).toHaveLength(0);
    });

    it('claims at most the limit, earliest due first', async () => {
      await scheduled(new Date('2026-03-10T08:30:00.000Z'), { name: 'second' });
      await scheduled(new Date('2026-03-10T08:00:00.000Z'), { name: 'first' });

      const claimed = await repo.claimDueConfigs(NOW, LEASE, 1);

      expect(claimed.map(c => c.name)).toEqual(['first']);
    });

    it('records the outcome and next slot', async () => {
      const config = await scheduled(new Date('2026-03-10T09:00:00.000Z'));
      const next = new Date('2026-03-11T09:00:00.000Z');

      await repo.recordScheduleOutcome(config.id, 'daily', { outcome: 'started', at: NOW, runId: 'run-1' }, next);

      const stored = await repo.findByIdInLake(config.id, LAKE);
      expect(stored?.nextRunAt).toEqual(next);
      expect(stored?.lastScheduledOutcome).toMatchObject({ outcome: 'started', runId: 'run-1' });
    });

    // A user who switched scheduling off mid-tick must not see it come back on.
    it('leaves a config alone whose cadence changed since the claim', async () => {
      const config = await scheduled(new Date('2026-03-10T09:00:00.000Z'));
      await repo.updateConfig(config.id, LAKE, {
        cadence: 'off',
        trigger: 'on_demand',
        nextRunAt: null,
        lastUpdatedByUserId: 'user-1',
      });

      await repo.recordScheduleOutcome(
        config.id,
        'daily',
        { outcome: 'started', at: NOW, runId: 'run-1' },
        new Date('2026-03-11T09:00:00.000Z')
      );

      const stored = await repo.findByIdInLake(config.id, LAKE);
      expect(stored?.nextRunAt).toBeNull();
      expect(stored?.lastScheduledOutcome).toBeNull();
    });
  });
});
