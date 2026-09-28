import { beforeEach, describe, expect, it, vi } from 'vitest';

const findByDatalakeTag = vi.fn();
const recallLakeMemoryMock = vi.fn(async () => []);

vi.mock('@bike4mind/database', () => ({
  dataLakeRepository: { findByDatalakeTag: (...args: unknown[]) => findByDatalakeTag(...args) },
  fabFileRepository: {},
}));
vi.mock('../embeddings/effectiveEmbeddingModel', () => ({
  resolveEffectiveEmbeddingModel: async () => 'text-embedding-3-small',
}));
vi.mock('./recallLakeMemory', () => ({
  recallLakeMemory: (...args: unknown[]) => recallLakeMemoryMock(...(args as [])),
}));

import { recallLakeMemoryForSession } from './lakeMemoryRecall';

describe('recallLakeMemoryForSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    recallLakeMemoryMock.mockResolvedValue([]);
    findByDatalakeTag.mockResolvedValue({
      createdByUserId: 'owner-1',
      status: 'active',
      lakeMemoryEnabled: true,
    });
  });

  /**
   * The one assertion that pins the FIX rather than the seam. `recallLakeMemory` still accepts a
   * `resolveSourceDates` injection and its own tests still exercise the fold, so every test on that
   * side would keep passing if this wiring handed it a resolver again - and the only resolver
   * available answers with the FabFile's upload time. Assert the absence here, at the one call site
   * that decides what production does.
   */
  it('wires no source-dates resolver, so recalled beliefs carry no date', async () => {
    await recallLakeMemoryForSession({ userId: 'u1', query: 'pto policy', dataLakeTags: ['datalake:hr'], k: 5 });

    expect(recallLakeMemoryMock).toHaveBeenCalledTimes(1);
    const opts = recallLakeMemoryMock.mock.calls[0][0] as Record<string, unknown>;
    expect(opts).not.toHaveProperty('resolveSourceDates');
    // The reachability resolver IS still wired - without this, the assertion above would also pass
    // on a call that had quietly stopped injecting anything at all.
    expect(typeof opts.resolveReachableSources).toBe('function');
  });
});
