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

  it('selects only stranded pending files (stale, with a real filePath)', async () => {
    h.lean.mockResolvedValue([]);
    await runModerationRescueSweep({ enabled: true, limit: 50, logger });
    const filter = h.find.mock.calls[0][0];
    expect(filter.moderationStatus).toBe('pending');
    expect(filter.deletedAt).toBe(null);
    expect(filter.createdAt.$lt).toBeInstanceOf(Date);
    expect(filter.filePath.$exists).toBe(true);
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
    const res = await runModerationRescueSweep({ enabled: false, limit: 50, logger });
    expect(res).toEqual({ rescanned: 0 });
    expect(h.moderate).not.toHaveBeenCalled();
  });

  it('forwards enabled=false so a disabled scan resolves clean rather than skipping the file', async () => {
    h.lean.mockResolvedValue([{ filePath: 'k', userId: 'u' }]);
    await runModerationRescueSweep({ enabled: false, limit: 50, logger });
    expect(h.moderate).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
  });
});
