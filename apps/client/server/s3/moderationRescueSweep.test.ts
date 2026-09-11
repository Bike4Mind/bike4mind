import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  updateMany: vi.fn(),
  find: vi.fn(),
  lean: vi.fn(),
  moderate: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  FabFile: { updateMany: h.updateMany, find: h.find },
}));
vi.mock('@server/s3/moderateImportedKnowledgeFiles', () => ({ moderateImportedKnowledgeFiles: h.moderate }));
vi.mock('@server/s3/knowledgeModerationDeps', () => ({ buildKnowledgeModerationDeps: () => ({ marker: 'deps' }) }));

import { runModerationRescueSweep } from './moderationRescueSweep';

const logger = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never;

beforeEach(() => {
  vi.clearAllMocks();
  h.updateMany.mockResolvedValue({});
  h.moderate.mockResolvedValue({ scanned: 1 });
  // find(...).limit(...).lean()
  h.find.mockReturnValue({ limit: vi.fn().mockReturnValue({ lean: h.lean }) });
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
  });

  it('selects every stale pending row regardless of prefix, so ordinary uploads recover too', async () => {
    h.lean.mockResolvedValue([]);
    await runModerationRescueSweep({ enabled: true, limit: 50, logger });
    const filter = h.find.mock.calls[0][0];
    expect(filter.moderationStatus).toBe('pending');
    expect(filter.deletedAt).toBe(null);
    expect(filter.createdAt.$lt).toBeInstanceOf(Date);
    // NOT prefix-scoped: an ordinary (non-knowledge) upload whose scan crashed must be re-scanned too,
    // or it sits pending -> permanently unservable. The knowledge/ prefix gates only the per-row
    // missing-object soft-delete (below), never the selection.
    expect(filter.filePath).toBeUndefined();
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
});
