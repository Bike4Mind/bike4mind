import { describe, it, expect, vi, type Mock } from 'vitest';
import { FabFileChunkRepository } from './FabFileModel';

/**
 * Pins the relationship between the ANN request's `limit` and the `numCandidates` exploration
 * budget `vectorSearch` derives from it.
 *
 * WHY THIS IS PINNED. `semanticDataLakeSearch` triples the requested limit when the per-document
 * cap can bind (`DIVERSITY_CANDIDATE_POOL_FACTOR`), and on a realistic lake the `fileIds.length`
 * term already dominates, so `numCandidates` does not move. That reads like the index is being
 * asked for more than it explored for, and it is not: `limit * 10` sits inside the same `max`, so
 * the budget can never fall below 10x whatever limit is requested. The widening lowers the ratio
 * toward that floor and never through it. Without a test the floor is an incidental property of
 * one `Math.max` argument that a plausible refactor (dropping the term that "never wins" on a real
 * lake) would delete silently, since no ANN query fails when its candidate pool is too narrow - it
 * just returns worse neighbours.
 *
 * No mongo: `$vectorSearch` is Atlas-only and cannot execute against mongodb-memory-server, so
 * this asserts the pipeline the repository BUILDS - and, in the second block, the two paths that
 * build none. Fake-model + `aggregate` spy follows `src/__tests__/facet-compatibility.test.ts`.
 */

// Registered in ALL_MODEL_DIMENSIONS, so getAtlasIndexForModel resolves a real target and
// vectorSearch does not take its fail-closed `return []` path.
const REGISTERED_MODEL = 'text-embedding-3-small';

// Atlas's documented ceiling on numCandidates, mirrored by the Math.min in vectorSearch. The
// `limit * 10` floor holds only while it stays under this, i.e. limit <= 1000.
const ATLAS_MAX_NUM_CANDIDATES = 10_000;

const createRepository = () => {
  const aggregate = vi.fn().mockResolvedValue([]);
  const model = { aggregate } as unknown as ConstructorParameters<typeof FabFileChunkRepository>[0];
  return { repository: new FabFileChunkRepository(model), aggregate };
};

const readNumCandidates = (aggregate: Mock): number => {
  const pipeline = aggregate.mock.calls[0]?.[0] as Array<{ $vectorSearch?: { numCandidates?: unknown } }> | undefined;
  const numCandidates = pipeline?.[0]?.$vectorSearch?.numCandidates;
  if (typeof numCandidates !== 'number') {
    throw new Error('vectorSearch built no $vectorSearch stage carrying a numeric numCandidates');
  }
  return numCandidates;
};

/** Runs one vectorSearch and returns the numCandidates it asked Atlas for. */
const numCandidatesFor = async (fileCount: number, limit: number): Promise<number> => {
  const { repository, aggregate } = createRepository();
  const fileIds = Array.from({ length: fileCount }, (_, i) => `file-${i}`);
  await repository.vectorSearch(fileIds, [0.1, 0.2, 0.3], REGISTERED_MODEL, { limit });
  return readNumCandidates(aggregate);
};

describe('FabFileChunkRepository.vectorSearch numCandidates', () => {
  // Spans both regimes: the small file sets where `limit * 10` wins outright, and the realistic
  // lakes where `fileIds.length * 50` buries it. 300 is the widest limit any caller can reach
  // (the public API caps top_k at 100, tripled by the diversity pool).
  it.each([
    { fileCount: 1, limit: 6 },
    { fileCount: 1, limit: 18 },
    { fileCount: 1, limit: 300 },
    { fileCount: 4, limit: 18 },
    { fileCount: 40, limit: 6 },
    { fileCount: 40, limit: 18 },
    { fileCount: 500, limit: 300 },
  ])('explores at least 10x the requested limit (files=$fileCount, limit=$limit)', async ({ fileCount, limit }) => {
    const numCandidates = await numCandidatesFor(fileCount, limit);

    expect(numCandidates).toBeGreaterThanOrEqual(limit * 10);
    // Atlas rejects a request that returns more than it explored; the 10x floor implies this, but
    // it is the constraint the server actually enforces.
    expect(numCandidates).toBeGreaterThanOrEqual(limit);
  });

  it('holds the floor when the diversity pool triples the limit on a lake that dominates it', async () => {
    // The exact shape the widening produces: topK 6 -> 18 against a lake where fileIds.length * 50
    // is the winning term both times.
    const beforeWidening = await numCandidatesFor(40, 6);
    const afterWidening = await numCandidatesFor(40, 18);

    // Unchanged, as the DIVERSITY_CANDIDATE_POOL_FACTOR docblock describes. That is the intended
    // outcome, not a shortfall: `limit` truncates a traversal numCandidates has already paid for,
    // so a wider limit appends lower-ranked rows to an identical candidate set.
    expect(afterWidening).toBe(beforeWidening);
    expect(afterWidening).toBeGreaterThanOrEqual(18 * 10);
  });

  it('scales with the limit where the file-count term cannot carry it', async () => {
    // A single-file lake contributes 50, under the floor of 100, so the limit term is the only
    // thing that can widen the pool - and it does.
    expect(await numCandidatesFor(1, 6)).toBe(100);
    expect(await numCandidatesFor(1, 18)).toBe(180);
  });

  it('holds the floor up to the limit where the Atlas ceiling takes over', async () => {
    // Derived from the ceiling rather than from a caller's cap: the two callers that bound the
    // limit live in apps/client and b4m-core/services, which this package cannot import, so a
    // literal copied from them here would be free to drift. The boundary is a property of the
    // formula alone.
    const widestLimitPreservingFloor = ATLAS_MAX_NUM_CANDIDATES / 10;

    expect(await numCandidatesFor(1, widestLimitPreservingFloor)).toBe(ATLAS_MAX_NUM_CANDIDATES);

    // One past it the clamp wins and the budget stops tracking the limit. Nothing can request that
    // today (the public API caps top_k at 100, tripled to 300 by the diversity pool), so this
    // documents where the guarantee ends rather than a live gap - it is the assumption to re-check
    // if a caller is ever allowed a wider limit.
    const beyond = widestLimitPreservingFloor + 1;
    expect(await numCandidatesFor(1, beyond)).toBeLessThan(beyond * 10);
  });

  it('never exceeds the Atlas ceiling on a lake large enough to blow past it', async () => {
    expect(await numCandidatesFor(1_000, 10)).toBe(ATLAS_MAX_NUM_CANDIDATES);
  });
});

describe('FabFileChunkRepository.vectorSearch fail-closed guards', () => {
  // Both paths return [] before building a pipeline. They are asserted here because they are what
  // stops the numCandidates cases above from passing vacuously: if either early return started
  // swallowing a real query, readNumCandidates would have nothing to read. The fail-closed
  // contract is also promised in vectorSearch's own docblock and was otherwise untested.

  it('queries nothing when the file set is empty', async () => {
    const { repository, aggregate } = createRepository();

    await expect(repository.vectorSearch([], [0.1, 0.2, 0.3], REGISTERED_MODEL)).resolves.toEqual([]);
    expect(aggregate).not.toHaveBeenCalled();
  });

  it('queries nothing when the model has no registered Atlas index', async () => {
    const { repository, aggregate } = createRepository();

    await expect(repository.vectorSearch(['file-0'], [0.1, 0.2, 0.3], 'not-a-registered-model')).resolves.toEqual([]);
    expect(aggregate).not.toHaveBeenCalled();
  });
});
