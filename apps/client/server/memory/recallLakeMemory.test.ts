import { describe, it, expect, vi, beforeEach } from 'vitest';
import { recallLakeMemory } from './recallLakeMemory';

/**
 * The belief budget is the caller's `k` (the `lakeMemoryRecallK` admin setting), not the 8 this
 * module used to hardcode (#2496). LakeMemoryFeature's own suite covers resolving the setting; what
 * is only provable here is the last hop - that the resolved number is what `recall` actually caps
 * on, which is what makes `promptMeta.context.lakeMemory.beliefCount` move when an admin raises it.
 *
 * `@bike4mind/common` is deliberately NOT mocked: it contributes only MEMENTO_MIN_SIMILARITY here,
 * and a whole-barrel mock would break the moment this module imports anything else from it.
 */
const mocks = vi.hoisted(() => ({
  recall: vi.fn(),
  embeddingScorer: vi.fn(),
  readProfile: vi.fn(),
  embedMementoQuery: vi.fn(),
}));

vi.mock('@bike4mind/memory', () => ({
  recall: mocks.recall,
  embeddingScorer: mocks.embeddingScorer,
}));
vi.mock('@bike4mind/database', () => ({
  memoryLedgerRepository: {},
  memoryPrincipalKeyRepository: {},
}));
vi.mock('./factCipher', () => ({ createKeyProvider: () => ({}) }));
vi.mock('./ledgerMemoryStore', () => ({
  createLedgerMemoryStore: () => ({ readProfile: mocks.readProfile }),
}));
vi.mock('./mementoQueryEmbedding', () => ({ embedMementoQuery: mocks.embedMementoQuery }));

const belief = (id: string) => ({ id, fact: `fact ${id}`, sources: ['doc-1'], shredded: false });

const run = (k: number) =>
  recallLakeMemory({
    userId: 'u1',
    query: 'when does acme ship',
    lakes: [{ datalakeTag: 'datalake:acme', ownerUserId: 'creator-1' }],
    resolveReachableSources: async ids => new Set(ids),
    k,
  });

describe('recallLakeMemory belief budget', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.embeddingScorer.mockReturnValue(() => 1);
    mocks.embedMementoQuery.mockResolvedValue({ vector: [1, 0], model: 'text-embedding-ada-002' });
    mocks.readProfile.mockResolvedValue({ beliefs: Array.from({ length: 50 }, (_, i) => belief(`b${i}`)) });
    // Echo the cap back the way the real `recall` does (filter, sort, then slice) so the assertions
    // below are about the budget reaching the recall, not a re-test of recall's own ranking.
    mocks.recall.mockImplementation((beliefs: Array<{ fact: string }>, _q: string, opts: { k: number }) =>
      beliefs.slice(0, opts.k).map(b => ({ belief: b, relevance: 0.9 }))
    );
  });

  it("caps the card at the caller's k, not a module constant", async () => {
    const beliefs = await run(24);
    expect(mocks.recall).toHaveBeenCalledWith(
      expect.anything(),
      'when does acme ship',
      expect.objectContaining({ k: 24 })
    );
    // The behavior the acceptance criterion is written against: with the budget raised, a lake with
    // a large belief set injects MORE than the eight this used to be pinned at.
    expect(beliefs).toHaveLength(24);
  });

  it('honors a lowered k too, so the setting is a budget and not just a raised floor', async () => {
    // Guards the direction a "raise the default" change makes it easy to stop testing: an admin who
    // sets 2 must get 2, which a Math.max(8, k) style regression would silently ignore.
    const beliefs = await run(2);
    expect(mocks.recall).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ k: 2 }));
    expect(beliefs).toHaveLength(2);
  });

  it('passes the budget through on the lexical-degradation path as well', async () => {
    // A failed query embed drops the scorer and the cosine floor; the cap must survive that branch,
    // which assembles its recall options from a different conditional spread.
    mocks.embedMementoQuery.mockRejectedValue(new Error('embeddings down'));
    await run(24);
    const opts = mocks.recall.mock.calls[0][2] as { k: number; minRelevance?: number; scorer?: unknown };
    expect(opts.k).toBe(24);
    expect(opts.scorer).toBeUndefined();
    expect(opts.minRelevance).toBeUndefined();
  });
});
