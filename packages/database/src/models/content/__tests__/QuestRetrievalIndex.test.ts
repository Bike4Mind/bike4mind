import { describe, it, expect } from 'vitest';
import { Quest } from '../QuestModel';

type DeclaredIndex = [Record<string, number>, Record<string, unknown> | undefined];

/**
 * /api/admin/retrieval-rate matches `{ 'promptMeta.retrieval': { $exists: true } }` sorted by
 * timestamp desc, and its MAX_TURNS_SCANNED comment claims the limit is served from this index
 * rather than by examining every Quest. Pinned here because that claim is invisible from the
 * endpoint: drop the index and the endpoint still passes its own tests, just as a collection scan
 * with a blocking sort.
 */
describe('Quest retrieval-rate index', () => {
  const declared = Quest.schema.indexes() as unknown as DeclaredIndex[];
  const index = declared.find(([, options]) => options?.name === 'retrieval_timestamp_desc');

  it('is declared', () => {
    expect(index).toBeDefined();
  });

  it('sorts by timestamp descending, matching the endpoint sort', () => {
    expect(index?.[0]).toEqual({ timestamp: -1 });
  });

  it('is partial on the exact endpoint filter, so only retrieval turns are indexed', () => {
    // Partial rather than sparse: sparse would index every Quest that has a `timestamp`, which is
    // all of them, and would not narrow the scan at all.
    expect(index?.[1]?.partialFilterExpression).toEqual({ 'promptMeta.retrieval': { $exists: true } });
    expect(index?.[1]?.sparse).toBeUndefined();
  });
});
