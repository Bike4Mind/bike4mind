import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  updateMany: vi.fn(),
  find: vi.fn(),
  sort: vi.fn(),
  lean: vi.fn(),
  moderate: vi.fn(),
  buildMeter: vi.fn(),
  limit: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  FabFile: { updateMany: h.updateMany, find: h.find },
}));
vi.mock('@bike4mind/server-utils/s3/moderateImportedKnowledgeFiles', () => ({
  moderateImportedKnowledgeFiles: h.moderate,
}));
vi.mock('@server/s3/knowledgeModerationDeps', () => ({ buildKnowledgeModerationDeps: () => ({ marker: 'deps' }) }));
vi.mock('@server/s3/uploadModerationMeter', () => ({ buildUploadModerationMeter: h.buildMeter }));

import { runModerationRescueSweep } from './moderationRescueSweep';

const logger = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never;

beforeEach(() => {
  vi.clearAllMocks();
  h.updateMany.mockResolvedValue({});
  h.moderate.mockResolvedValue({ scanned: 1 });
  // find(...).sort(...).limit(...).lean()
  h.find.mockReturnValue({ sort: h.sort.mockReturnValue({ limit: h.limit.mockReturnValue({ lean: h.lean }) }) });
});

describe('runModerationRescueSweep', () => {
  it('first returns stale scanning claims to pending, gated on a staleness cutoff', async () => {
    h.lean.mockResolvedValue([]);
    await runModerationRescueSweep({ enabled: true, limit: 50, logger });
    const [filter, update] = h.updateMany.mock.calls[0];
    expect(filter.moderationStatus).toBe('scanning');
    expect(filter.deletedAt).toBe(null);
    // Gated on the dedicated claim stamp (with a legacy updatedAt fallback), not updatedAt directly.
    expect(filter.$or[0].moderationClaimedAt.$lt).toBeInstanceOf(Date);
    expect(filter.$or[1].updatedAt.$lt).toBeInstanceOf(Date);
    expect(update.$set.moderationStatus).toBe('pending');
    // A crashed scan spent an attempt: count it, or a row that crashes its runner every time stays
    // at attempts 0 and keeps winning the fairness sort ahead of never-tried rows forever.
    expect(update.$inc).toEqual({ moderationAttempts: 1 });
    // The stamp is only meaningful while 'scanning'; leaving it set would let a superseded runner's
    // identity-guarded write still match.
    expect(update.$unset).toEqual({ moderationClaimedAt: 1 });
    // But NOT moderationLastAttemptAt: this reclaim is the only door that frees the row, so backing
    // it off here would stop the same run from ever rescuing it.
    expect(update.$set.moderationLastAttemptAt).toBeUndefined();
  });

  it('selects imported OR completed-upload pending rows, excluding abandoned presigns', async () => {
    h.lean.mockResolvedValue([]);
    await runModerationRescueSweep({ enabled: true, limit: 50, logger });
    const filter = h.find.mock.calls[0][0];
    expect(filter.moderationStatus).toBe('pending');
    expect(filter.deletedAt).toBe(null);
    expect(filter.createdAt.$lt).toBeInstanceOf(Date);
    // filePath must exist and be non-empty (it drives the claim/download and is optional on the schema).
    expect(filter.filePath).toEqual({ $exists: true, $ne: '' });
    // Two arms: imported-knowledge keys, OR any completed upload (status 'complete'). An abandoned
    // presign (bare key, status still 'pending') matches neither, so it is never selected/re-selected.
    const arms = filter.$and[0].$or as Array<{ filePath?: RegExp; status?: string }>;
    const knowledgeArm = arms.find(a => a.filePath instanceof RegExp);
    expect(knowledgeArm?.filePath?.test('knowledge/u1/abc')).toBe(true);
    expect(knowledgeArm?.filePath?.test('9f2c-abc.png')).toBe(false);
    expect(arms).toContainEqual({ status: 'complete' });
  });

  it('backs off a row whose last attempt failed recently, but never one that has not been tried', async () => {
    h.lean.mockResolvedValue([]);
    await runModerationRescueSweep({ enabled: true, limit: 50, logger });
    const backoff = h.find.mock.calls[0][0].$and[1].$or as Array<{ moderationLastAttemptAt: unknown }>;
    // `null` matches missing-or-null, so a never-attempted row is always eligible. A bare $lt would
    // exclude it: $lt does not match across BSON type brackets.
    expect(backoff[0]).toEqual({ moderationLastAttemptAt: null });
    expect((backoff[1].moderationLastAttemptAt as { $lt: Date }).$lt).toBeInstanceOf(Date);
  });

  it('orders selection by attempt count so a failing cluster cannot starve a stranded row', async () => {
    // The starvation fix: an unset moderationAttempts sorts before any number, so a never-attempted
    // row always takes a slot in the bounded window ahead of repeatedly-failing siblings - the
    // guarantee, independent of how the backoff window is tuned. createdAt is the tiebreaker.
    h.lean.mockResolvedValue([]);
    await runModerationRescueSweep({ enabled: true, limit: 50, logger });
    expect(h.sort).toHaveBeenCalledWith({ moderationAttempts: 1, createdAt: 1 });
  });

  it('reclaims stale scanning rows regardless of prefix, so a crashed ordinary upload is not stranded', async () => {
    // The stale-'scanning' reclaim is deliberately NOT filePath-scoped: it only moves
    // scanning -> pending (non-terminal), and is the sole writer that frees a crashed ordinary
    // (non-knowledge) upload's claim. Scoping it would strand ordinary uploads on 'scanning' forever.
    h.lean.mockResolvedValue([]);
    await runModerationRescueSweep({ enabled: true, limit: 50, logger });
    expect(h.updateMany.mock.calls[0][0].filePath).toBeUndefined();
  });

  it('re-scans each stranded file with its own owner and forwards the enabled flag', async () => {
    h.lean.mockResolvedValue([
      { filePath: 'knowledge/u1/a', userId: 'u1' },
      { filePath: 'knowledge/u2/b', userId: 'u2' },
    ]);
    const res = await runModerationRescueSweep({ enabled: true, limit: 50, logger });
    expect(res).toEqual({ rescanned: 2 });
    expect(h.moderate).toHaveBeenCalledTimes(2);
    expect(h.moderate).toHaveBeenCalledWith(expect.objectContaining({ filePaths: ['knowledge/u1/a'], userId: 'u1' }));
    expect(h.moderate).toHaveBeenCalledWith(expect.objectContaining({ filePaths: ['knowledge/u2/b'], userId: 'u2' }));
    // A swept knowledge/ row past the age floor whose object is gone is a permanent orphan: retire it
    // terminally instead of releasing it to be re-selected forever (the starvation fix).
    expect(h.moderate).toHaveBeenCalledWith(expect.objectContaining({ terminalOnMissingObject: true }));
  });

  it('re-scans an ordinary (non-knowledge) upload but never soft-deletes it on a missing object', async () => {
    // terminalOnMissingObject must be false for a bare-key upload: its row predates its bytes, so a
    // missing object may be an upload that never completed, not a permanent orphan to retire.
    h.lean.mockResolvedValue([
      { filePath: 'knowledge/u1/a', userId: 'u1' },
      { filePath: '9f2c-abc.png', userId: 'u2' },
    ]);
    await runModerationRescueSweep({ enabled: true, limit: 50, logger });
    expect(h.moderate).toHaveBeenCalledWith(
      expect.objectContaining({ filePaths: ['knowledge/u1/a'], terminalOnMissingObject: true })
    );
    expect(h.moderate).toHaveBeenCalledWith(
      expect.objectContaining({ filePaths: ['9f2c-abc.png'], terminalOnMissingObject: false })
    );
  });

  it('does not scan when nothing is stranded', async () => {
    h.lean.mockResolvedValue([]);
    const res = await runModerationRescueSweep({ enabled: true, limit: 50, logger });
    expect(res).toEqual({ rescanned: 0 });
    expect(h.moderate).not.toHaveBeenCalled();
  });

  it('no-ops entirely when moderation is disabled, so the held backlog is never whitewashed', async () => {
    // A disabled scan resolves 'clean' terminally, so running the sweep with moderation off would
    // permanently un-gate every row held while moderation was on. The sweep must not even query.
    h.lean.mockResolvedValue([{ filePath: 'knowledge/u/a', userId: 'u' }]);
    const res = await runModerationRescueSweep({ enabled: false, limit: 50, logger });
    expect(res).toEqual({ rescanned: 0 });
    expect(h.updateMany).not.toHaveBeenCalled();
    expect(h.find).not.toHaveBeenCalled();
    expect(h.moderate).not.toHaveBeenCalled();
  });

  describe('moderation allowance on upload rows', () => {
    const upload = (id: string, userId: string) => ({ _id: id, filePath: `${id}.png`, userId });
    const knowledge = (id: string, userId: string) => ({ _id: id, filePath: `knowledge/${userId}/${id}`, userId });

    it('meters ordinary uploads against their owner and leaves imports unmetered', async () => {
      h.lean.mockResolvedValueOnce([knowledge('k1', 'u1'), upload('f1', 'u2')]).mockResolvedValue([]);
      h.buildMeter.mockReturnValue({ marker: 'meter' });

      await runModerationRescueSweep({ enabled: true, limit: 50, logger });

      const [importCall, uploadCall] = h.moderate.mock.calls.map(([args]) => args);
      expect(importCall.meterFor).toBeUndefined();
      expect(uploadCall.meterFor('ff1')).toEqual({ marker: 'meter' });
      expect(h.buildMeter).toHaveBeenCalledWith({ userId: 'u2', fabFileId: 'ff1', logger });
    });

    it("skips a refused user's other uploads and refills the window with other users' files", async () => {
      h.lean
        .mockResolvedValueOnce([upload('a1', 'ua'), upload('a2', 'ua'), knowledge('k1', 'ua')])
        .mockResolvedValueOnce([upload('b1', 'ub')])
        .mockResolvedValue([]);
      h.moderate.mockImplementation(async ({ userId }: { userId: string }) =>
        userId === 'ua' ? { scanned: 0, deferred: 1 } : { scanned: 1, deferred: 0 }
      );

      const res = await runModerationRescueSweep({ enabled: true, limit: 3, logger });

      expect(h.moderate.mock.calls.map(([args]) => args.filePaths[0])).toEqual(['a1.png', 'knowledge/ua/k1', 'b1.png']);
      expect(res).toEqual({ rescanned: 1 });
      expect(h.limit.mock.calls.map(([size]) => size)).toEqual([3, 1]);
      const refill = h.find.mock.calls[1][0];
      expect(refill.$nor).toEqual([{ userId: { $in: ['ua'] }, filePath: { $not: expect.any(RegExp) } }]);
      expect(refill.$nor[0].filePath.$not.test('knowledge/ua/k1')).toBe(true);
      expect(refill._id).toEqual({ $nin: ['a1', 'a2', 'k1'] });
    });

    it('hands each of two rows sharing a path to the scan', async () => {
      h.lean
        .mockResolvedValueOnce([upload('a1', 'ua'), { ...upload('a2', 'ua'), filePath: 'a1.png' }])
        .mockResolvedValue([]);

      await runModerationRescueSweep({ enabled: true, limit: 5, logger });

      expect(h.moderate.mock.calls.map(([args]) => args.filePaths[0])).toEqual(['a1.png', 'a1.png']);
    });

    it('stops once a refill returns only rows it has already seen', async () => {
      h.lean.mockResolvedValue([upload('a1', 'ua')]);
      h.moderate.mockResolvedValue({ scanned: 0, deferred: 1 });

      await runModerationRescueSweep({ enabled: true, limit: 5, logger });

      expect(h.moderate).toHaveBeenCalledTimes(1);
      expect(h.find).toHaveBeenCalledTimes(2);
    });
  });
});
