import { describe, it, expect, vi } from 'vitest';
import { collectStaleVectorClaims, type StaleVectorClaimCandidate } from './collectStaleVectorClaims';

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
