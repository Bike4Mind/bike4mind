import { describe, it, expect, vi, afterEach } from 'vitest';
import type { CreateDataLakeResearchConfigInput } from '@bike4mind/common';
import type { ResearchFeedCursor } from '@bike4mind/common';
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
  source: 'search',
  feedUrl: null,
  query: 'coastal erosion',
  maxResults: 10,
  maxProposals: 5,
  trustedDomains: [],
  reviewDomains: [],
  unlistedSources: 'review',
  autoAdmitTrusted: false,
  maxAutoAdmits: 3,
  allowedDomains: [],
  blockedDomains: [],
  minRelevance: 0.6,
  costCeilingMicroUsd: 50_000,
  proposedTags: [],
  itemRules: [],
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

  it('round-trips the auto-admit levers, and an old document reads as off with the default cap', async () => {
    const on = await repo.createConfig(input({ autoAdmitTrusted: true, maxAutoAdmits: 7 }));
    expect(on).toMatchObject({ autoAdmitTrusted: true, maxAutoAdmits: 7 });

    const { id } = await repo.createConfig(input({ name: 'old' }));
    await DataLakeResearchConfigModel.collection.updateOne(
      { name: 'old' },
      { $unset: { autoAdmitTrusted: '', maxAutoAdmits: '' } }
    );
    const read = await repo.findByIdInLake(id, LAKE);
    expect(read).toMatchObject({ autoAdmitTrusted: false, maxAutoAdmits: 3 });
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

  it('pages by keyset without skipping or repeating rows that share a createdAt', async () => {
    const ids: string[] = [];
    for (const name of ['a', 'b', 'c', 'd', 'e']) ids.push((await repo.createConfig(input({ name }))).id);
    await DataLakeResearchConfigModel.collection.updateMany(
      { dataLakeId: LAKE },
      { $set: { createdAt: new Date('2026-01-01T00:00:00.000Z') } }
    );

    const seen: string[] = [];
    let after: { createdAt: Date; id: string } | undefined;
    for (let page = 0; page < 5; page++) {
      const rows = await repo.listByLake(LAKE, { limit: 2, after });
      seen.push(...rows.map(r => r.id));
      if (rows.length < 2) break;
      after = { createdAt: rows[rows.length - 1].createdAt, id: rows[rows.length - 1].id };
    }

    expect(seen).toEqual([...ids].sort().reverse());
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

    it('does not claim a paused config, and still records an outcome for one paused mid-tick', async () => {
      const paused = await scheduled(new Date('2026-03-10T09:00:00.000Z'), { schedulePaused: true });

      expect(await repo.claimDueConfigs(NOW, LEASE, 10)).toHaveLength(0);

      const next = new Date('2026-03-17T09:00:00.000Z');
      await repo.recordScheduleOutcome(
        paused.id,
        'daily',
        { outcome: 'skipped', at: NOW, reason: 'schedule_paused' },
        next
      );
      const stored = await repo.findByIdInLake(paused.id, LAKE);
      expect(stored?.nextRunAt).toEqual(next);
      expect(stored?.lastScheduledOutcome).toMatchObject({ reason: 'schedule_paused' });
    });

    it('reads a config with no schedulePaused as not paused, and claims it', async () => {
      await scheduled(new Date('2026-03-10T09:00:00.000Z'));
      expect(await repo.claimDueConfigs(NOW, LEASE, 10)).toHaveLength(1);
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

  describe('item rules', () => {
    it('round-trips rules, and a document without the field reads as none', async () => {
      const itemRules = [
        { condition: 'Published by Acme', action: 'block' as const },
        { condition: 'About sports', action: 'review' as const },
      ];
      const created = await repo.createConfig(input({ itemRules }));
      expect((await repo.findByIdInLake(created.id, LAKE))?.itemRules).toEqual(itemRules);

      const { insertedId } = await DataLakeResearchConfigModel.collection.insertOne({
        dataLakeId: LAKE,
        name: 'Old',
        query: 'q',
        maxResults: 10,
        maxProposals: 5,
        minRelevance: 0.6,
        costCeilingMicroUsd: 50_000,
        trigger: 'on_demand',
        createdByUserId: 'user-1',
      });
      expect((await repo.findByIdInLake(String(insertedId), LAKE))?.itemRules).toEqual([]);
    });

    it('refuses an action other than block or review', async () => {
      await expect(
        repo.createConfig(input({ itemRules: [{ condition: 'c', action: 'allow' as never }] }))
      ).rejects.toThrow();
    });
  });

  describe('source tiers', () => {
    const rawLegacy = (overrides: Record<string, unknown> = {}) =>
      DataLakeResearchConfigModel.collection.insertOne({
        dataLakeId: LAKE,
        name: 'Legacy',
        query: 'q',
        maxResults: 10,
        maxProposals: 5,
        blockedDomains: ['bad.example'],
        minRelevance: 0.6,
        costCeilingMicroUsd: 50_000,
        proposedTags: [],
        trigger: 'on_demand',
        createdByUserId: 'user-1',
        ...overrides,
      });

    it('reads a raw legacy document back upgraded, keeping allowedDomains', async () => {
      const { insertedId } = await rawLegacy({ allowedDomains: ['a.example'] });

      const read = await repo.findByIdInLake(String(insertedId), LAKE);

      expect(read).toMatchObject({
        trustedDomains: [],
        reviewDomains: ['a.example'],
        unlistedSources: 'drop',
        allowedDomains: ['a.example'],
        blockedDomains: ['bad.example'],
      });
    });

    it('reads a raw legacy document with no allow list as other sites to review', async () => {
      const { insertedId } = await rawLegacy();
      const [listed] = await repo.listByLake(LAKE);
      expect(listed).toMatchObject({ unlistedSources: 'review', reviewDomains: [], allowedDomains: [] });
      expect(listed.id).toBeDefined();
      expect(String(listed.id)).toBe(String(insertedId));
    });

    it('applies an edit old code made to allowedDomains after the migration ran', async () => {
      const { insertedId } = await rawLegacy({
        trustedDomains: [],
        reviewDomains: ['old.example'],
        unlistedSources: 'drop',
        allowedDomains: ['edited.example'],
      });
      const read = await repo.findByIdInLake(String(insertedId), LAKE);
      expect(read).toMatchObject({ reviewDomains: ['edited.example'], unlistedSources: 'drop' });
    });

    it('returns the upgraded shape from the scheduler claim', async () => {
      await rawLegacy({ allowedDomains: ['a.example'], cadence: 'daily', nextRunAt: new Date('2026-01-01') });
      const [claimed] = await repo.claimDueConfigs(new Date('2026-02-01'), new Date('2026-02-02'), 5);
      expect(claimed).toMatchObject({ reviewDomains: ['a.example'], unlistedSources: 'drop' });
    });

    it('stores the tier fields written by new code and returns the derived allowedDomains', async () => {
      const created = await repo.createConfig(
        input({ reviewDomains: ['r.example'], unlistedSources: 'drop', allowedDomains: ['r.example'] })
      );
      const raw = await DataLakeResearchConfigModel.collection.findOne({ dataLakeId: LAKE });
      expect(raw).toMatchObject({ unlistedSources: 'drop', allowedDomains: ['r.example'] });
      expect(created).toMatchObject({ reviewDomains: ['r.example'], unlistedSources: 'drop' });
    });

    it('does not default unlistedSources, which is how a legacy document is recognized', async () => {
      const { insertedId } = await rawLegacy({ allowedDomains: [] });
      const hydrated = await DataLakeResearchConfigModel.findById(insertedId);
      expect(hydrated?.unlistedSources).toBeUndefined();
    });

    it('keeps an undeclared stored field in toJSON, so the upgrade sees it', async () => {
      const { insertedId } = await rawLegacy({ allowedDomains: [], somethingUndeclared: 1 });
      const hydrated = await DataLakeResearchConfigModel.findById(insertedId);
      expect(hydrated?.toJSON()).toHaveProperty('somethingUndeclared');
      expect(await repo.findByIdInLake(String(insertedId), LAKE)).toMatchObject({ unlistedSources: 'review' });
    });
  });
  describe('feed source and cursor', () => {
    const FEED = 'https://example.com/feed.xml';
    const cursor = (overrides: Partial<ResearchFeedCursor> = {}): ResearchFeedCursor => ({
      fingerprint: 'fp-1',
      newestPublishedAt: new Date('2026-11-01T00:00:00Z'),
      seenKeys: ['example.com/a', 'example.com/b'],
      retries: [{ key: 'example.com/c', attempts: 2 }],
      ...overrides,
    });

    it('round-trips source and feedUrl, and reads a stored search config as search with no feed', async () => {
      const feed = await repo.createConfig(input({ source: 'feed', feedUrl: FEED }));
      expect(feed).toMatchObject({ source: 'feed', feedUrl: FEED, feedCursor: null });

      const { id } = await repo.createConfig(input({ name: 'old' }));
      await DataLakeResearchConfigModel.collection.updateOne(
        { name: 'old' },
        { $unset: { source: '', feedUrl: '', feedCursor: '' } }
      );
      expect(await repo.findByIdInLake(id, LAKE)).toMatchObject({ source: 'search', feedUrl: null });
    });

    it('writes the cursor when the feed url matches and reports the match', async () => {
      const { id } = await repo.createConfig(input({ source: 'feed', feedUrl: FEED }));

      expect(await repo.recordFeedCursor(id, FEED, cursor())).toBe(true);

      const reread = await repo.findByIdInLake(id, LAKE);
      expect(reread?.feedCursor).toMatchObject({
        fingerprint: 'fp-1',
        newestPublishedAt: new Date('2026-11-01T00:00:00Z'),
        seenKeys: ['example.com/a', 'example.com/b'],
        retries: [{ key: 'example.com/c', attempts: 2 }],
      });
    });

    it('round-trips the feed address key', async () => {
      const { id } = await repo.createConfig(input({ source: 'feed', feedUrl: FEED }));

      await repo.recordFeedCursor(id, FEED, cursor({ feedUrlKey: 'url-key-1' }));

      expect((await repo.findByIdInLake(id, LAKE))?.feedCursor?.feedUrlKey).toBe('url-key-1');
    });

    it('drops a cursor from a run of a feed the config has since left', async () => {
      const { id } = await repo.createConfig(input({ source: 'feed', feedUrl: FEED }));
      await repo.updateConfig(id, LAKE, { feedUrl: 'https://example.com/other.xml' });

      expect(await repo.recordFeedCursor(id, FEED, cursor())).toBe(false);
      expect((await repo.findByIdInLake(id, LAKE))?.feedCursor).toBeNull();
    });

    it('replaces a cursor written under an older fingerprint', async () => {
      const { id } = await repo.createConfig(input({ source: 'feed', feedUrl: FEED }));
      await repo.recordFeedCursor(id, FEED, cursor());

      await repo.recordFeedCursor(id, FEED, cursor({ fingerprint: 'fp-2', seenKeys: ['example.com/z'], retries: [] }));

      expect((await repo.findByIdInLake(id, LAKE))?.feedCursor).toMatchObject({
        fingerprint: 'fp-2',
        seenKeys: ['example.com/z'],
        retries: [],
      });
    });

    it('does not let a config update through the lever path touch the cursor', async () => {
      const { id } = await repo.createConfig(input({ source: 'feed', feedUrl: FEED }));
      await repo.recordFeedCursor(id, FEED, cursor());

      await repo.updateConfig(id, LAKE, { query: 'new topic' });

      expect((await repo.findByIdInLake(id, LAKE))?.feedCursor).toMatchObject({ fingerprint: 'fp-1' });
    });
  });

  describe('error handling on by-id lookups', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('reads a malformed id as not found from find, update and delete', async () => {
      expect(await repo.findByIdInLake('not-an-object-id', LAKE)).toBeNull();
      expect(await repo.updateConfig('not-an-object-id', LAKE, { name: 'x' })).toBeNull();
      expect(await repo.deleteConfig('not-an-object-id', LAKE)).toBe(false);
    });

    it('propagates a transient transaction error from find, update and delete', async () => {
      const id = '507f1f77bcf86cd799439011';
      const conflict = () =>
        Object.assign(new Error('Write conflict during plan execution'), {
          name: 'MongoServerError',
          errorLabels: ['TransientTransactionError'],
        });
      vi.spyOn(DataLakeResearchConfigModel, 'findOne').mockImplementation((() => Promise.reject(conflict())) as never);
      vi.spyOn(DataLakeResearchConfigModel, 'findOneAndUpdate').mockImplementation((() =>
        Promise.reject(conflict())) as never);
      vi.spyOn(DataLakeResearchConfigModel, 'deleteOne').mockImplementation((() =>
        Promise.reject(conflict())) as never);

      await expect(repo.findByIdInLake(id, LAKE)).rejects.toMatchObject({ name: 'MongoServerError' });
      await expect(repo.updateConfig(id, LAKE, { name: 'x' })).rejects.toMatchObject({ name: 'MongoServerError' });
      await expect(repo.deleteConfig(id, LAKE)).rejects.toMatchObject({ name: 'MongoServerError' });
    });
  });
});
