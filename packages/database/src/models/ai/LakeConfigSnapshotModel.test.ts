import { describe, it, expect, beforeEach } from 'vitest';
import type { ILakeConfigSnapshot } from '@bike4mind/common';
import { lakeConfigSnapshotRepository as repo, LakeConfigSnapshotModel } from './LakeConfigSnapshotModel';
import { setupMongoTest } from '../../__test__/utils';

const FEED_BEFORE = 'https://example.com/feed.xml?token=secret-abc';
const FEED_AFTER = 'https://example.com/other.xml?token=secret-def';

const snapshot = (over: Partial<ILakeConfigSnapshot> = {}): ILakeConfigSnapshot => ({
  dataLakeId: 'lake-1',
  eventId: 'evt-1',
  kind: 'feed-url-edited',
  feedUrlBefore: FEED_BEFORE,
  feedUrlAfter: FEED_AFTER,
  expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
  ...over,
});

describe('LakeConfigSnapshotRepository', () => {
  setupMongoTest();
  beforeEach(async () => {
    await LakeConfigSnapshotModel.ensureIndexes();
  });

  it('holds the full feed addresses, query string included', async () => {
    await repo.record(snapshot());
    const found = await repo.findLive('lake-1', 'evt-1');
    expect(found?.feedUrlBefore).toBe(FEED_BEFORE);
    expect(found?.feedUrlAfter).toBe(FEED_AFTER);
  });

  it('holds the full config of a deleted research config', async () => {
    await repo.record(
      snapshot({
        eventId: 'evt-2',
        kind: 'config-deleted',
        config: { name: 'Sweep', feedUrl: FEED_BEFORE, itemRules: [] },
      })
    );
    const found = await repo.findLive('lake-1', 'evt-2');
    expect(found?.config).toMatchObject({ name: 'Sweep', feedUrl: FEED_BEFORE });
  });

  it('does not return an expired snapshot, even before the TTL sweep removes it', async () => {
    await repo.record(snapshot({ expiresAt: new Date('2026-01-01T00:00:00Z') }));
    expect(await repo.findLive('lake-1', 'evt-1', new Date('2026-01-02T00:00:00Z'))).toBeNull();
    expect(await repo.findLive('lake-1', 'evt-1', new Date('2025-12-31T00:00:00Z'))).not.toBeNull();
  });

  it('declares a TTL index on expiresAt', async () => {
    const indexes = await LakeConfigSnapshotModel.collection.indexes();
    expect(indexes.find(i => i.key.expiresAt === 1)?.expireAfterSeconds).toBe(0);
  });

  it('keys one snapshot per event and lake', async () => {
    await repo.record(snapshot());
    await expect(repo.record(snapshot())).rejects.toThrow(/duplicate key|E11000/i);
    await repo.record(snapshot({ dataLakeId: 'lake-2' }));
  });

  it('deleteForLake removes only that lake', async () => {
    await repo.record(snapshot());
    await repo.record(snapshot({ eventId: 'evt-2' }));
    await repo.record(snapshot({ dataLakeId: 'lake-2' }));
    expect(await repo.deleteForLake('lake-1')).toBe(2);
    expect(await repo.findLive('lake-1', 'evt-1')).toBeNull();
    expect(await repo.findLive('lake-2', 'evt-1')).not.toBeNull();
  });
});
