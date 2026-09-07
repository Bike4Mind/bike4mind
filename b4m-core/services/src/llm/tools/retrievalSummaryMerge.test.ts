import { describe, it, expect } from 'vitest';
import { mergeRetrievalSummary, type RetrievalSummary } from './retrievalSummaryMerge';

const base = (over: Partial<RetrievalSummary> = {}): RetrievalSummary => ({
  attempted: true,
  outcome: 'ok',
  surfaces: [],
  dataLakeTags: [],
  ...over,
});

/** The seed written at the offeredTools site: the turn could have retrieved, and did not (yet). */
const seed = (mode: 'forced' | 'optional'): RetrievalSummary => ({
  attempted: false,
  mode,
  surfaces: [],
  dataLakeTags: [],
});

describe('mergeRetrievalSummary', () => {
  it('passes the defined side through when one side is missing', () => {
    const summary = base();
    expect(mergeRetrievalSummary(undefined, summary)).toBe(summary);
    expect(mergeRetrievalSummary(summary, undefined)).toBe(summary);
    expect(mergeRetrievalSummary(undefined, undefined)).toBeUndefined();
  });

  it('ORs attempted, so one surface running is enough', () => {
    expect(mergeRetrievalSummary(seed('optional'), base())?.attempted).toBe(true);
    expect(mergeRetrievalSummary(base(), seed('optional'))?.attempted).toBe(true);
    expect(mergeRetrievalSummary(seed('optional'), seed('optional'))?.attempted).toBe(false);
  });

  it('keeps the worst outcome, so a failure is never masked by a later success', () => {
    expect(mergeRetrievalSummary(base({ outcome: 'ok' }), base({ outcome: 'failed' }))?.outcome).toBe('failed');
    expect(mergeRetrievalSummary(base({ outcome: 'failed' }), base({ outcome: 'ok' }))?.outcome).toBe('failed');
    expect(mergeRetrievalSummary(base({ outcome: 'no_lakes' }), base({ outcome: 'ok' }))?.outcome).toBe('ok');
  });

  it('ranks not_indexed between ok and failed, so an unsearchable corpus survives a success', () => {
    // The severity map lives in this module, so its full ordering is pinned here rather than only
    // where a caller happens to exercise it.
    expect(mergeRetrievalSummary(base({ outcome: 'ok' }), base({ outcome: 'not_indexed' }))?.outcome).toBe(
      'not_indexed'
    );
    expect(mergeRetrievalSummary(base({ outcome: 'not_indexed' }), base({ outcome: 'failed' }))?.outcome).toBe(
      'failed'
    );
  });

  describe('absent outcome (the not-attempted seed)', () => {
    it('never erases a real outcome, in either merge order', () => {
      // 'no_lakes' is the tightest case: it is the LOWEST real severity, so if absent lost to
      // anything it would lose to this.
      expect(mergeRetrievalSummary(seed('forced'), base({ outcome: 'no_lakes' }))?.outcome).toBe('no_lakes');
      expect(mergeRetrievalSummary(base({ outcome: 'no_lakes' }), seed('forced'))?.outcome).toBe('no_lakes');
    });

    it('leaves the key off entirely when neither side ran', () => {
      const merged = mergeRetrievalSummary(seed('forced'), seed('forced'));
      expect(merged?.outcome).toBeUndefined();
      expect(merged && 'outcome' in merged).toBe(false);
    });
  });

  describe('mode', () => {
    it('lets forced win over optional in either order', () => {
      expect(mergeRetrievalSummary(seed('forced'), base({ mode: 'optional' }))?.mode).toBe('forced');
      expect(mergeRetrievalSummary(base({ mode: 'optional' }), seed('forced'))?.mode).toBe('forced');
    });

    it('keeps optional when nothing claims the turn was forced', () => {
      expect(mergeRetrievalSummary(seed('optional'), base({ mode: 'optional' }))?.mode).toBe('optional');
    });

    it('survives a write from a surface that does not assert a mode', () => {
      expect(mergeRetrievalSummary(seed('forced'), base())?.mode).toBe('forced');
      expect(mergeRetrievalSummary(base(), seed('optional'))?.mode).toBe('optional');
    });

    it('stays absent when neither side knows it (pre-existing documents)', () => {
      const merged = mergeRetrievalSummary(base(), base());
      expect(merged?.mode).toBeUndefined();
      expect(merged && 'mode' in merged).toBe(false);
    });
  });

  describe('forcedSkipReason', () => {
    it('survives the seed-then-skip write order the forced arm actually produces', () => {
      const merged = mergeRetrievalSummary(seed('forced'), {
        attempted: false,
        mode: 'forced',
        forcedSkipReason: 'attached_files',
        surfaces: [],
        dataLakeTags: [],
      });
      expect(merged?.forcedSkipReason).toBe('attached_files');
      expect(merged?.attempted).toBe(false);
    });

    it('survives a later tool-arm retrieval on the same turn', () => {
      const skipped: RetrievalSummary = {
        attempted: false,
        mode: 'forced',
        forcedSkipReason: 'personal_corpus',
        surfaces: [],
        dataLakeTags: [],
      };
      const merged = mergeRetrievalSummary(skipped, base({ surfaces: ['knowledgeBaseSearch'] }));
      expect(merged).toMatchObject({
        attempted: true,
        outcome: 'ok',
        mode: 'forced',
        forcedSkipReason: 'personal_corpus',
        surfaces: ['knowledgeBaseSearch'],
      });
    });

    it('keeps the first defined value rather than last-writer-wins', () => {
      const first = base({ forcedSkipReason: 'attached_files' });
      const second = base({ forcedSkipReason: 'personal_corpus' });
      expect(mergeRetrievalSummary(first, second)?.forcedSkipReason).toBe('attached_files');
    });
  });

  it('unions surfaces and dataLakeTags without duplicates', () => {
    const merged = mergeRetrievalSummary(
      base({ surfaces: ['forced-retrieval'], dataLakeTags: ['a'] }),
      base({ surfaces: ['knowledgeBaseSearch', 'forced-retrieval'], dataLakeTags: ['a', 'b'] })
    );
    expect(merged?.surfaces).toEqual(['forced-retrieval', 'knowledgeBaseSearch']);
    expect(merged?.dataLakeTags).toEqual(['a', 'b']);
  });

  describe('injectedLakePromptIds', () => {
    it('unions ids without duplicates and derives the count from the union', () => {
      const merged = mergeRetrievalSummary(
        base({ injectedLakePromptIds: ['lake1'] }),
        base({ injectedLakePromptIds: ['lake1', 'lake2'] })
      );
      expect(merged?.injectedLakePromptIds).toEqual(['lake1', 'lake2']);
      expect(merged?.injectedLakePromptCount).toBe(2);
    });

    it('stays absent when neither side injected a lake prompt', () => {
      const merged = mergeRetrievalSummary(base(), base());
      expect(merged?.injectedLakePromptIds).toBeUndefined();
      expect(merged && 'injectedLakePromptIds' in merged).toBe(false);
    });

    it('is present-and-empty when an injection site ran but nothing qualified', () => {
      const merged = mergeRetrievalSummary(base(), base({ injectedLakePromptIds: [] }));
      expect(merged?.injectedLakePromptIds).toEqual([]);
      expect(merged?.injectedLakePromptCount).toBe(0);
    });

    it('survives a side that never asserted the field', () => {
      const merged = mergeRetrievalSummary(base({ injectedLakePromptIds: ['lake1'] }), base());
      expect(merged?.injectedLakePromptIds).toEqual(['lake1']);
      expect(merged?.injectedLakePromptCount).toBe(1);
    });
  });
});
