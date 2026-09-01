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
