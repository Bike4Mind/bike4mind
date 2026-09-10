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

  describe('injected volume', () => {
    it('sums chunks and chars across two surfaces and keeps the best score', () => {
      const merged = mergeRetrievalSummary(
        base({ surfaces: ['forced-retrieval'], injected: { chunks: 3, chars: 900, topScore: 0.71 } }),
        base({ surfaces: ['knowledgeBaseSearch'], injected: { chunks: 2, chars: 400, topScore: 0.88 } })
      );
      // Total volume the model received this turn - not the last writer's slice of it.
      expect(merged?.injected).toEqual({ chunks: 5, chars: 1300, topScore: 0.88 });
    });

    it('stays absent when neither side reports a volume', () => {
      const merged = mergeRetrievalSummary(base(), base());
      // Absent must survive the merge: it means unknown, and a merge that manufactured a zero
      // would report a starve on a turn nobody measured.
      expect(merged?.injected).toBeUndefined();
      expect(merged && 'injected' in merged).toBe(false);
    });

    it('passes a one-sided volume through in either argument order', () => {
      const volume = { chunks: 4, chars: 1200, topScore: 0.6 };
      // The 'failed'-surface case: a side with nothing to report must not erase what the other
      // side measured, and must not be able to zero it either.
      expect(mergeRetrievalSummary(base({ injected: volume }), base())?.injected).toEqual(volume);
      expect(mergeRetrievalSummary(base(), base({ injected: volume }))?.injected).toEqual(volume);
    });

    it('preserves a recorded zero rather than collapsing it into absence', () => {
      const merged = mergeRetrievalSummary(base({ injected: { chunks: 0, chars: 0 } }), base());
      expect(merged?.injected).toEqual({ chunks: 0, chars: 0 });
    });

    it("does not let an absent score clobber the other side's", () => {
      // Lake memory reports no topScore at all. If absence defaulted to 0 it would win any Math.max
      // against a real negative cosine, and lose to a real positive one it should not be ranked
      // against in the first place.
      const merged = mergeRetrievalSummary(
        base({ injected: { chunks: 1, chars: 100, topScore: -0.2 } }),
        base({ injected: { chunks: 2, chars: 200 } })
      );
      expect(merged?.injected).toEqual({ chunks: 3, chars: 300, topScore: -0.2 });
    });

    it('omits topScore entirely when neither side has one', () => {
      const merged = mergeRetrievalSummary(
        base({ injected: { chunks: 1, chars: 100 } }),
        base({ injected: { chunks: 0, chars: 0 } })
      );
      expect(merged?.injected).toEqual({ chunks: 1, chars: 100 });
      // Explicit-undefined would persist as a set-but-empty Mongoose path.
      expect(merged?.injected && 'topScore' in merged.injected).toBe(false);
    });

    describe('preRelativeFloorCandidates', () => {
      it('sums across surfaces, same as chunks', () => {
        const merged = mergeRetrievalSummary(
          base({ injected: { chunks: 2, chars: 400, preRelativeFloorCandidates: 4 } }),
          base({ injected: { chunks: 1, chars: 200, preRelativeFloorCandidates: 3 } })
        );
        expect(merged?.injected?.preRelativeFloorCandidates).toBe(7);
      });

      it('passes a one-sided count through without treating the other side as zero', () => {
        // Only forced retrieval ever writes this field - a knowledge-tool surface reporting volume
        // alongside it must not turn the absent side into a recorded 0.
        const merged = mergeRetrievalSummary(
          base({ injected: { chunks: 2, chars: 400, preRelativeFloorCandidates: 4 } }),
          base({ injected: { chunks: 1, chars: 200 } })
        );
        expect(merged?.injected).toEqual({ chunks: 3, chars: 600, preRelativeFloorCandidates: 4 });
      });

      it('omits the field entirely when neither side reports one', () => {
        const merged = mergeRetrievalSummary(base({ injected: { chunks: 1, chars: 100 } }), base());
        expect(merged?.injected).toEqual({ chunks: 1, chars: 100 });
        expect(merged?.injected && 'preRelativeFloorCandidates' in merged.injected).toBe(false);
      });

      it('sums a recorded zero rather than treating it as absent', () => {
        const merged = mergeRetrievalSummary(
          base({ injected: { chunks: 0, chars: 0, preRelativeFloorCandidates: 0 } }),
          base({ injected: { chunks: 1, chars: 100, preRelativeFloorCandidates: 2 } })
        );
        expect(merged?.injected?.preRelativeFloorCandidates).toBe(2);
      });
    });

    it('keeps volume alongside a worse outcome from another surface', () => {
      const merged = mergeRetrievalSummary(
        base({ outcome: 'ok', surfaces: ['forced-retrieval'], injected: { chunks: 12, chars: 4000 } }),
        base({ outcome: 'failed', surfaces: ['knowledgeBaseSearch'] })
      );
      // outcome is worst-of, injected is sum-of-completions: the two can disagree in tone on a
      // multi-surface turn, and both are true.
      expect(merged?.outcome).toBe('failed');
      expect(merged?.injected).toEqual({ chunks: 12, chars: 4000 });
    });
  });

  describe('knowledgeBaseGuidanceInjected', () => {
    it('preserves an explicit false through a merge that never asserts the field', () => {
      // The regression this pins: `false || undefined` is undefined, so a boolean-OR merge would
      // drop the A/B's control arm into the unrecorded bucket and quietly bias the comparison.
      const merged = mergeRetrievalSummary(base({ knowledgeBaseGuidanceInjected: false }), base());
      expect(merged?.knowledgeBaseGuidanceInjected).toBe(false);
    });

    it('preserves a true through a later tool-arm write', () => {
      const merged = mergeRetrievalSummary(
        base({ knowledgeBaseGuidanceInjected: true }),
        base({ attempted: true, outcome: 'ok', surfaces: ['knowledgeBaseSearch'] })
      );
      expect(merged?.knowledgeBaseGuidanceInjected).toBe(true);
    });

    it('stays absent when neither side recorded it', () => {
      const merged = mergeRetrievalSummary(base(), base());
      expect(merged && 'knowledgeBaseGuidanceInjected' in merged).toBe(false);
    });

    it('takes the incoming value when the existing side never recorded it', () => {
      const merged = mergeRetrievalSummary(base(), base({ knowledgeBaseGuidanceInjected: false }));
      expect(merged?.knowledgeBaseGuidanceInjected).toBe(false);
    });
  });

  describe('preauthorizedLakeIdsUsed', () => {
    it('unions ids without duplicates, independent of injectedLakePromptIds', () => {
      const merged = mergeRetrievalSummary(
        base({ injectedLakePromptIds: ['lake1'], preauthorizedLakeIdsUsed: ['lake1'] }),
        base({ injectedLakePromptIds: ['lake1', 'lake2'], preauthorizedLakeIdsUsed: ['lake1'] })
      );
      expect(merged?.preauthorizedLakeIdsUsed).toEqual(['lake1']);
    });

    it('stays absent when neither side used a pre-authorized lake', () => {
      const merged = mergeRetrievalSummary(base(), base());
      expect(merged && 'preauthorizedLakeIdsUsed' in merged).toBe(false);
    });

    it('survives a side that never asserted the field', () => {
      const merged = mergeRetrievalSummary(base({ preauthorizedLakeIdsUsed: ['lake1'] }), base());
      expect(merged?.preauthorizedLakeIdsUsed).toEqual(['lake1']);
    });
  });
});
