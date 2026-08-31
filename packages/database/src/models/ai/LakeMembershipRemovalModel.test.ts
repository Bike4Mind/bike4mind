import { describe, it, expect, beforeEach } from 'vitest';
import type { ILakeMembershipRemoval } from '@bike4mind/common';
import { lakeMembershipRemovalRepository as repo, LakeMembershipRemovalModel } from './LakeMembershipRemovalModel';
import { setupMongoTest } from '../../__test__/utils';

// Relative to the real clock (not a fixed calendar date), so a lookup with no explicit `asOf`
// (the real caller's default) sees a genuinely live row regardless of when the suite runs.
const removal = (overrides: Partial<ILakeMembershipRemoval> = {}): ILakeMembershipRemoval => ({
  dataLakeId: 'lake-1',
  fabFileId: 'file-1',
  actorUserId: 'actor-1',
  contentTags: [{ name: 'lk:invoices', strength: 1 }],
  removedAt: new Date(),
  expiresAt: new Date(Date.now() + 30 * 60 * 1000),
  ...overrides,
});

describe('LakeMembershipRemovalRepository', () => {
  setupMongoTest();
  // setupMongoTest's beforeEach dropDatabase()s (indexes included), and this model is not in its
  // one-time ensureIndexes list - rebuild the unique index per test so the collision case is real.
  beforeEach(async () => {
    await LakeMembershipRemovalModel.ensureIndexes();
  });

  it('upsert creates one row, then updates it in place on the (lake, file) key - a remove -> undo -> remove cycle', async () => {
    const created = await repo.upsertRemoval(removal({ contentTags: [{ name: 'lk:invoices', strength: 1 }] }));
    expect(created.contentTags).toEqual([{ name: 'lk:invoices', strength: 1 }]);

    const later = removal({
      actorUserId: 'actor-2',
      contentTags: [{ name: 'lk:contracts', strength: 1 }],
      removedAt: new Date('2026-08-30T01:00:00Z'),
      expiresAt: new Date('2026-08-30T01:30:00Z'),
    });
    const updated = await repo.upsertRemoval(later);

    expect(updated.id).toBe(created.id); // same row, not a second removal record
    expect(updated.actorUserId).toBe('actor-2');
    expect(updated.contentTags).toEqual([{ name: 'lk:contracts', strength: 1 }]);

    const count = await LakeMembershipRemovalModel.countDocuments({ dataLakeId: 'lake-1', fabFileId: 'file-1' });
    expect(count).toBe(1);
  });

  it('enforces one row per (lake, file) via the unique index', async () => {
    await repo.upsertRemoval(removal());
    // A raw create bypassing upsert must collide on the unique key.
    await expect(LakeMembershipRemovalModel.create(removal() as unknown as Record<string, unknown>)).rejects.toThrow(
      /duplicate key|E11000/i
    );
  });

  it('distinguishes rows that share a fabFileId across different lakes', async () => {
    await repo.upsertRemoval(removal({ dataLakeId: 'lake-1', fabFileId: 'file-1' }));
    await repo.upsertRemoval(removal({ dataLakeId: 'lake-2', fabFileId: 'file-1' }));

    const lake1 = await repo.findLive('lake-1', 'file-1');
    const lake2 = await repo.findLive('lake-2', 'file-1');
    expect(lake1?.dataLakeId).toBe('lake-1');
    expect(lake2?.dataLakeId).toBe('lake-2');
  });

  describe('findLive - the restore authorization lookup', () => {
    it('returns the row when its expiresAt is strictly after asOf', async () => {
      await repo.upsertRemoval(removal({ expiresAt: new Date('2026-08-30T00:30:00Z') }));
      const found = await repo.findLive('lake-1', 'file-1', new Date('2026-08-30T00:15:00Z'));
      expect(found).not.toBeNull();
    });

    it('excludes a row past its expiresAt EVEN BEFORE the TTL sweeper would remove it', async () => {
      // The Mongo TTL monitor runs on roughly a one-minute cycle, so a raw find() would still see
      // an expired row for a window; the lookup query itself is what must exclude it.
      await repo.upsertRemoval(removal({ expiresAt: new Date('2026-08-30T00:30:00Z') }));

      const found = await repo.findLive('lake-1', 'file-1', new Date('2026-08-30T00:31:00Z'));
      expect(found).toBeNull();
      // Confirms the row itself is still physically present - only the query, not the sweeper,
      // is why findLive returned null.
      const stillThere = await LakeMembershipRemovalModel.findOne({ dataLakeId: 'lake-1', fabFileId: 'file-1' });
      expect(stillThere).not.toBeNull();
    });

    // Pins `$gt` rather than `$gte`: both pass the two tests above, since neither lands ON the
    // boundary. The window is closed at its own expiry, which is the fail-closed direction for a
    // lookup that is itself an authorization gate.
    it('excludes a row when asOf lands exactly ON expiresAt', async () => {
      const expiresAt = new Date('2026-08-30T00:30:00Z');
      await repo.upsertRemoval(removal({ expiresAt }));

      expect(await repo.findLive('lake-1', 'file-1', new Date(expiresAt))).toBeNull();
      expect(await repo.findLive('lake-1', 'file-1', new Date(expiresAt.getTime() - 1))).not.toBeNull();
    });

    it('returns null for a lake/file with no removal recorded', async () => {
      expect(await repo.findLive('lake-1', 'file-1')).toBeNull();
    });

    it('has a TTL index on expiresAt', async () => {
      const indexes = await LakeMembershipRemovalModel.collection.indexes();
      const ttlIndex = indexes.find(idx => idx.key?.expiresAt === 1);
      expect(ttlIndex).toBeDefined();
      expect(ttlIndex?.expireAfterSeconds).toBe(0);
    });
  });
});
