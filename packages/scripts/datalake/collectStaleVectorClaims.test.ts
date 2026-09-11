import { describe, it, expect, vi } from 'vitest';
import {
  collectStaleVectorClaims,
  repairStaleVectorClaims,
  type StaleVectorClaimCandidate,
} from './collectStaleVectorClaims';

/**
 * Fakes the two repository primitives (proven separately against real Mongo in
 * FabFileModel.staleVectorClaims.test.ts) so the sweep's own paging and pairing are testable
 * without a DB - the part `check-stale-vector-claims` would otherwise only exercise in production.
 */
const makeDeps = (files: { id: string; fileName?: string; hasChunks: boolean }[]) => {
  const candidates: StaleVectorClaimCandidate[] = files.map(({ id, fileName }) => ({ id, fileName }));
  return {
    findFileIdsWithPositiveVectorizedCount: vi.fn(
      async ({ limit = 500, afterFileId }: { limit?: number; afterFileId?: string }) => {
        const start = afterFileId ? candidates.findIndex(c => c.id === afterFileId) + 1 : 0;
        return candidates.slice(start, start + limit);
      }
    ),
    findFabFileIdsWithChunks: vi.fn(
      async (ids: string[]) => new Set(ids.filter(id => files.find(f => f.id === id)?.hasChunks))
    ),
  };
};

describe('collectStaleVectorClaims (#2583)', () => {
  it('flags only the candidates with no chunk row behind their declared count', async () => {
    const deps = makeDeps([
      { id: 'f1', fileName: 'healthy.txt', hasChunks: true },
      { id: 'f2', fileName: 'stranded.txt', hasChunks: false },
      { id: 'f3', fileName: 'also-healthy.txt', hasChunks: true },
    ]);

    const report = await collectStaleVectorClaims(deps, { batchSize: 10 });

    expect(report.scanned).toBe(3);
    expect(report.stale).toEqual([{ id: 'f2', fileName: 'stranded.txt' }]);
  });

  it('pages with afterFileId until the candidate list is exhausted', async () => {
    const files = Array.from({ length: 5 }, (_, i) => ({ id: `f${i}`, hasChunks: i % 2 === 0 }));
    const deps = makeDeps(files);

    const report = await collectStaleVectorClaims(deps, { batchSize: 2 });

    // Three pages of 2/2/1, then the empty page that ends the loop. Every id seen exactly once:
    // a cursor that failed to advance would spin here rather than return.
    expect(deps.findFileIdsWithPositiveVectorizedCount).toHaveBeenCalledTimes(4);
    expect(deps.findFileIdsWithPositiveVectorizedCount.mock.calls.map(([opts]) => opts.afterFileId)).toEqual([
      undefined,
      'f1',
      'f3',
      'f4',
    ]);
    expect(report.scanned).toBe(5);
    expect(report.stale.map(f => f.id)).toEqual(['f1', 'f3']);
  });

  it('reports nothing and reads no chunks when no file declares a vectorized count', async () => {
    const deps = makeDeps([]);

    const report = await collectStaleVectorClaims(deps, { batchSize: 100 });

    expect(report).toEqual({ scanned: 0, stale: [] });
    expect(deps.findFabFileIdsWithChunks).not.toHaveBeenCalled();
  });
});

describe('repairStaleVectorClaims (#2583)', () => {
  it('resets exactly the flagged ids through the canonical reset', async () => {
    const resetChunkStateByIds = vi.fn(async (ids: string[]) => ids);

    const repair = await repairStaleVectorClaims({ resetChunkStateByIds }, ['f2', 'f5']);

    expect(resetChunkStateByIds).toHaveBeenCalledWith(['f2', 'f5']);
    expect(repair).toEqual({ reset: ['f2', 'f5'], skipped: [] });
  });

  it('reports the ids the reset refused rather than claiming it repaired them', async () => {
    // `resetChunkStateByIds` is preconditioned on `isChunking: {$ne: true}` and returns only the
    // ids it changed. Counting the request as the result would report a clean repair over files
    // still claiming chunks they do not have - the silent-success this issue is about.
    const resetChunkStateByIds = vi.fn(async (ids: string[]) => ids.filter(id => id !== 'busy'));

    const repair = await repairStaleVectorClaims({ resetChunkStateByIds }, ['free', 'busy']);

    expect(repair).toEqual({ reset: ['free'], skipped: ['busy'] });
  });

  it('writes nothing when the sweep found nothing to repair', async () => {
    const resetChunkStateByIds = vi.fn(async (ids: string[]) => ids);

    expect(await repairStaleVectorClaims({ resetChunkStateByIds }, [])).toEqual({ reset: [], skipped: [] });
    expect(resetChunkStateByIds).not.toHaveBeenCalled();
  });
});
