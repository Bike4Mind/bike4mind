import { describe, it, expect } from 'vitest';
import { summarizeOptionalPathRetrieval } from './retrievalRate';
import type { PromptMeta } from '../types/entities/PromptMetaTypes';

type RetrievalSummary = NonNullable<PromptMeta['retrieval']>;

const turn = (over: Partial<RetrievalSummary>): RetrievalSummary => ({
  attempted: false,
  surfaces: [],
  dataLakeTags: [],
  ...over,
});

const offeredNoRetrieval = turn({ mode: 'optional' });
const offeredRetrieved = turn({
  mode: 'optional',
  attempted: true,
  outcome: 'ok',
  surfaces: ['knowledgeBaseSearch'],
});

describe('summarizeOptionalPathRetrieval', () => {
  describe('guidance A/B arms', () => {
    const injectedRetrieved = turn({
      mode: 'optional',
      attempted: true,
      outcome: 'ok',
      surfaces: ['knowledgeBaseSearch'],
      knowledgeBaseGuidanceInjected: true,
    });
    const injectedNoRetrieval = turn({ mode: 'optional', knowledgeBaseGuidanceInjected: true });
    const clearedRetrieved = turn({
      mode: 'optional',
      attempted: true,
      outcome: 'ok',
      surfaces: ['knowledgeBaseSearch'],
      knowledgeBaseGuidanceInjected: false,
    });
    const clearedNoRetrieval = turn({ mode: 'optional', knowledgeBaseGuidanceInjected: false });

    it('splits the offered population into the two arms the A/B compares', () => {
      const summary = summarizeOptionalPathRetrieval([
        injectedRetrieved,
        injectedRetrieved,
        injectedRetrieved,
        injectedNoRetrieval,
        clearedRetrieved,
        clearedNoRetrieval,
        clearedNoRetrieval,
        clearedNoRetrieval,
      ]);
      expect(summary.guidance.injected).toEqual({ turns: 4, retrievedTurns: 3, rate: 0.75 });
      expect(summary.guidance.notInjected).toEqual({ turns: 4, retrievedTurns: 1, rate: 0.25 });
      expect(summary.guidance.unrecorded).toEqual({ turns: 0, retrievedTurns: 0, rate: null });
    });

    it('keeps an explicit false in its own arm rather than with the unrecorded turns', () => {
      // The distinction the whole field exists for: "the section was switched off" is the control
      // arm, while "we never recorded it" is missing data. Collapsing them would let pre-field
      // traffic masquerade as control turns and wash out the comparison.
      const summary = summarizeOptionalPathRetrieval([clearedNoRetrieval, offeredNoRetrieval]);
      expect(summary.guidance.notInjected.turns).toBe(1);
      expect(summary.guidance.unrecorded.turns).toBe(1);
    });

    it('reports turns predating the flag as unrecorded, not as either arm', () => {
      const summary = summarizeOptionalPathRetrieval([offeredRetrieved, offeredNoRetrieval]);
      expect(summary.guidance.unrecorded).toEqual({ turns: 2, retrievedTurns: 1, rate: 0.5 });
      expect(summary.guidance.injected.turns).toBe(0);
      expect(summary.guidance.notInjected.turns).toBe(0);
    });

    it('always sums the three arms back to offeredTurns', () => {
      const summary = summarizeOptionalPathRetrieval([
        injectedRetrieved,
        clearedNoRetrieval,
        offeredRetrieved,
        turn({ mode: 'forced', attempted: true, outcome: 'ok', surfaces: ['forced-retrieval'] }),
        turn({ attempted: true, outcome: 'ok', surfaces: ['knowledgeBaseSearch'] }),
      ]);
      const { injected, notInjected, unrecorded } = summary.guidance;
      expect(injected.turns + notInjected.turns + unrecorded.turns).toBe(summary.offeredTurns);
      expect(injected.retrievedTurns + notInjected.retrievedTurns + unrecorded.retrievedTurns).toBe(
        summary.retrievedTurns
      );
    });

    it('reports a null arm rate rather than a phantom zero when an arm is empty', () => {
      const summary = summarizeOptionalPathRetrieval([injectedNoRetrieval]);
      expect(summary.guidance.injected.rate).toBe(0);
      expect(summary.guidance.notInjected.rate).toBeNull();
    });

    it('leaves forced turns out of both arms even when the flag is set', () => {
      // A forced turn is never in the experiment. The seed only writes the flag on offered turns,
      // but a forced turn that somehow carried one must still not enter the comparison.
      const summary = summarizeOptionalPathRetrieval([
        turn({
          mode: 'forced',
          attempted: true,
          outcome: 'ok',
          surfaces: ['forced-retrieval'],
          knowledgeBaseGuidanceInjected: true,
        }),
      ]);
      expect(summary.guidance.injected.turns).toBe(0);
      expect(summary.forcedTurns).toBe(1);
    });
  });

  it('reports a null rate rather than a phantom zero when nothing is in the population', () => {
    const summary = summarizeOptionalPathRetrieval([]);
    expect(summary.rate).toBeNull();
    expect(summary.forcedSuppressed.rate).toBeNull();
    expect(summary.offeredTurns).toBe(0);
  });

  it('divides retrieved turns by offered turns on the optional path', () => {
    const summary = summarizeOptionalPathRetrieval([
      offeredRetrieved,
      offeredRetrieved,
      offeredNoRetrieval,
      offeredNoRetrieval,
    ]);
    expect(summary).toMatchObject({ offeredTurns: 4, retrievedTurns: 2, rate: 0.5 });
  });

  it('counts a zero-result retrieval as a retrieval - the model still chose to look', () => {
    // 'ok' with nothing recalled is a legitimate retrieval per RetrievalSummarySchema. The
    // question here is whether the model reached for the corpus, not what came back.
    const summary = summarizeOptionalPathRetrieval([
      turn({ mode: 'optional', attempted: true, outcome: 'ok', surfaces: ['knowledgeBaseSearch'] }),
    ]);
    expect(summary.retrievedTurns).toBe(1);
  });

  it('counts a failed retrieval as a retrieval too', () => {
    const summary = summarizeOptionalPathRetrieval([
      turn({ mode: 'optional', attempted: true, outcome: 'failed', surfaces: ['knowledgeBaseSearch'] }),
    ]);
    expect(summary).toMatchObject({ offeredTurns: 1, retrievedTurns: 1, rate: 1 });
  });

  it('keeps forced turns out of the optional denominator', () => {
    const summary = summarizeOptionalPathRetrieval([
      turn({ mode: 'forced', attempted: true, outcome: 'ok', surfaces: ['forced-retrieval'] }),
      turn({ mode: 'forced', attempted: true, outcome: 'no_lakes', surfaces: ['forced-retrieval'] }),
      offeredRetrieved,
    ]);
    expect(summary).toMatchObject({ forcedTurns: 2, offeredTurns: 1, retrievedTurns: 1, rate: 1 });
  });

  describe('forced-but-suppressed turns', () => {
    // The population the routing question is actually about: forced retrieval was configured, a
    // rule suppressed it, and the model was left to decide for itself.
    it('scores them in their own bucket, not the optional one', () => {
      const summary = summarizeOptionalPathRetrieval([
        turn({ mode: 'forced', forcedSkipReason: 'attached_files' }),
        turn({
          mode: 'forced',
          forcedSkipReason: 'attached_files',
          attempted: true,
          outcome: 'ok',
          surfaces: ['knowledgeBaseSearch'],
        }),
        turn({ mode: 'forced', forcedSkipReason: 'personal_corpus' }),
      ]);
      expect(summary.forcedSuppressed).toEqual({
        turns: 3,
        retrievedTurns: 1,
        rate: 1 / 3,
        byReason: { attached_files: 2, personal_corpus: 1 },
      });
      // Suppressed turns never ran forced retrieval, so they are not forced turns either.
      expect(summary).toMatchObject({ forcedTurns: 0, offeredTurns: 0, rate: null });
    });
  });

  describe('automatic surfaces are not the model choosing to retrieve', () => {
    // The failure this guards: LakeMemoryFeature has no fabFileIds guard, so it injects its card
    // and records attempted:true on the very turns forced retrieval skipped for attached files.
    // The merged turn then looks identical to one where the model called a tool itself, which
    // inflates the one card the routing question leans on.
    it('excludes a lake-memory injection on a suppressed turn from the numerator', () => {
      const summary = summarizeOptionalPathRetrieval([
        turn({
          mode: 'forced',
          forcedSkipReason: 'attached_files',
          attempted: true,
          outcome: 'ok',
          surfaces: ['lake-memory'],
        }),
      ]);
      expect(summary.forcedSuppressed).toMatchObject({ turns: 1, retrievedTurns: 0, rate: 0 });
    });

    it('still counts the turn when the model called a knowledge tool alongside the injection', () => {
      const summary = summarizeOptionalPathRetrieval([
        turn({
          mode: 'forced',
          forcedSkipReason: 'attached_files',
          attempted: true,
          outcome: 'ok',
          surfaces: ['lake-memory', 'knowledgeBaseSearch'],
        }),
      ]);
      expect(summary.forcedSuppressed).toMatchObject({ turns: 1, retrievedTurns: 1, rate: 1 });
    });

    it('treats an unrecognised surface as not-model-initiated, so a new surface cannot inflate the rate', () => {
      const summary = summarizeOptionalPathRetrieval([
        turn({ mode: 'optional', attempted: true, outcome: 'ok', surfaces: ['some-future-auto-surface'] }),
      ]);
      expect(summary).toMatchObject({ offeredTurns: 1, retrievedTurns: 0, rate: 0 });
    });
  });

  it('reports pre-field turns instead of dropping them into a population', () => {
    // A window straddling the deploy: these carry a retrieval record but no mode, and folding
    // them into either bucket would quietly bias the rate.
    const summary = summarizeOptionalPathRetrieval([
      turn({ attempted: true, outcome: 'ok', surfaces: ['knowledgeBaseSearch'] }),
      offeredRetrieved,
    ]);
    expect(summary).toMatchObject({ unclassifiedTurns: 1, offeredTurns: 1, retrievedTurns: 1, rate: 1 });
  });

  it('skips turns with no retrieval record at all', () => {
    const summary = summarizeOptionalPathRetrieval([undefined, null, offeredRetrieved]);
    expect(summary).toMatchObject({ offeredTurns: 1, retrievedTurns: 1, unclassifiedTurns: 0 });
  });
});
