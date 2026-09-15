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

/**
 * Dating the recalled beliefs (#1501 item 4). The write path now keeps two documents' disagreeing
 * claims instead of letting the later one destroy the earlier, so the card has to tell the model
 * WHEN each claim was written - otherwise both readings arrive undifferentiated.
 */
describe('recallLakeMemory source dates', () => {
  const sourced = (id: string, sources: string[]) => ({ id, fact: `fact ${id}`, sources, shredded: false });

  const runWith = (input: {
    beliefs: Array<{ id: string; fact: string; sources: string[] }>;
    resolveSourceDates?: (sourceIds: string[]) => Promise<Map<string, string>>;
  }) => {
    mocks.readProfile.mockResolvedValue({ beliefs: input.beliefs });
    return recallLakeMemory({
      userId: 'u1',
      query: 'what is the uptime',
      lakes: [{ datalakeTag: 'datalake:acme', ownerUserId: 'creator-1' }],
      resolveReachableSources: async ids => new Set(ids),
      resolveSourceDates: input.resolveSourceDates,
      k: 24,
    });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.embeddingScorer.mockReturnValue(() => 1);
    mocks.embedMementoQuery.mockResolvedValue({ vector: [1, 0], model: 'text-embedding-ada-002' });
    mocks.recall.mockImplementation((beliefs: Array<{ fact: string }>, _q: string, opts: { k: number }) =>
      beliefs.slice(0, opts.k).map(b => ({ belief: b, relevance: 0.9 }))
    );
  });

  it('dates each belief by its source document', async () => {
    const recalled = await runWith({
      beliefs: [sourced('b1', ['doc-1']), sourced('b2', ['doc-2'])],
      resolveSourceDates: async () =>
        new Map([
          ['doc-1', '2026-03-14'],
          ['doc-2', '2025-01-02'],
        ]),
    });
    expect(recalled.map(r => r.sourceDate)).toEqual(['2026-03-14', '2025-01-02']);
  });

  it('reads dates only for the sources that survived the budget cut', async () => {
    // The reachability gate scans every source in the profile; dating must not repeat that cost.
    const resolveSourceDates = vi.fn(async () => new Map([['doc-1', '2026-03-14']]));
    mocks.recall.mockImplementation((beliefs: Array<{ fact: string }>) =>
      beliefs.slice(0, 1).map(b => ({ belief: b, relevance: 0.9 }))
    );
    await runWith({ beliefs: [sourced('b1', ['doc-1']), sourced('b2', ['doc-2'])], resolveSourceDates });
    expect(resolveSourceDates).toHaveBeenCalledWith(['doc-1']);
  });

  it('dates a multi-source belief by its most recent document', async () => {
    // The latest restatement of a claim is the one a reader weighs, and source order is not
    // chronological, so the reduce must pick the max rather than the first or the last.
    const [recalled] = await runWith({
      beliefs: [sourced('b1', ['doc-old', 'doc-new', 'doc-mid'])],
      resolveSourceDates: async () =>
        new Map([
          ['doc-old', '2024-05-01'],
          ['doc-new', '2026-03-14'],
          ['doc-mid', '2025-01-02'],
        ]),
    });
    expect(recalled.sourceDate).toBe('2026-03-14');
  });

  it('leaves a belief undated when none of its sources resolved', async () => {
    // A deleted document has no date to report; undated is honest, and the card renders it as
    // "unknown" rather than inventing one.
    const [recalled] = await runWith({
      beliefs: [sourced('b1', ['doc-gone'])],
      resolveSourceDates: async () => new Map(),
    });
    expect(recalled.sourceDate).toBeUndefined();
    expect(recalled.fact).toBe('fact b1');
  });

  it('recalls undated when no resolver is wired', async () => {
    const [recalled] = await runWith({ beliefs: [sourced('b1', ['doc-1'])] });
    expect(recalled).toEqual({ fact: 'fact b1', relevance: 0.9, sources: ['doc-1'] });
  });

  it('keeps the facts when the date read fails', async () => {
    // Dating is a nicety layered on top of the grounding; losing the FabFile read must cost the
    // dates for the turn, never the beliefs themselves.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const recalled = await runWith({
      beliefs: [sourced('b1', ['doc-1'])],
      resolveSourceDates: async () => {
        throw new Error('fabfiles down');
      },
    });
    expect(recalled).toHaveLength(1);
    expect(recalled[0].sourceDate).toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
