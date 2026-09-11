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

  it('selects only stranded, imported-knowledge pending files (stale, knowledge/ prefix)', async () => {
    h.lean.mockResolvedValue([]);
    await runModerationRescueSweep({ enabled: true, limit: 50, logger });
    const filter = h.find.mock.calls[0][0];
    expect(filter.moderationStatus).toBe('pending');
    expect(filter.deletedAt).toBe(null);
    expect(filter.createdAt.$lt).toBeInstanceOf(Date);
    // Scoped to import keys so the sweep never writes a terminal verdict on an ordinary presign upload.
    expect(filter.filePath).toBeInstanceOf(RegExp);
    expect(filter.filePath.test('knowledge/u1/abc')).toBe(true);
    expect(filter.filePath.test('9f2c-abc.png')).toBe(false);
    // Same scope on the stale-scanning reclaim.
    expect(h.updateMany.mock.calls[0][0].filePath).toBeInstanceOf(RegExp);
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
    // Swept rows are past the age floor, so a missing object is a permanent orphan: retire it
    // terminally instead of releasing it to be re-selected forever (the starvation fix).
    expect(h.moderate).toHaveBeenCalledWith(expect.objectContaining({ terminalOnMissingObject: true }));
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
