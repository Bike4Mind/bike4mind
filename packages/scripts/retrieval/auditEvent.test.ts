import { describe, expect, it } from 'vitest';
import { readRetrievalStatus, readServedDocuments, type RetrievalStatus } from './auditEvent';

/** The tool ran to completion and put passages in front of the model. */
const SERVED: RetrievalStatus = { kind: 'served-content' };
/** The tool ran to completion and had nothing to serve. */
const EMPTY: RetrievalStatus = { kind: 'no-content' };

describe('readRetrievalStatus', () => {
  it('reads a citables write as content having reached the model', () => {
    expect(readRetrievalStatus([{ citables: [{ id: 'f1' }], retrieval: { outcome: 'ok' } }])).toEqual(SERVED);
  });

  it('reads an ok write with no citables as a completed search that found nothing', () => {
    // The keyword arm's no-hit branch: outcome 'ok' precisely so it is distinguishable from
    // "never searched", but no citables because nothing was served.
    expect(readRetrievalStatus([{ retrieval: { outcome: 'ok' } }])).toEqual(EMPTY);
  });

  it('takes the last retrieval write as terminal but keeps citables from any of them', () => {
    // A semantic arm that found nothing falls through to the keyword arm, which writes again.
    expect(
      readRetrievalStatus([
        { citables: [{ id: 'f1' }], retrieval: { outcome: 'ok' } },
        { retrieval: { outcome: 'ok' } },
      ])
    ).toEqual(SERVED);
  });

  it('reports a non-ok outcome rather than reading it as an empty result', () => {
    expect(readRetrievalStatus([{ retrieval: { outcome: 'failed' } }])).toEqual({ kind: 'failed', outcome: 'failed' });
    expect(readRetrievalStatus([{ retrieval: { outcome: 'no_lakes' } }])).toEqual({
      kind: 'failed',
      outcome: 'no_lakes',
    });
    // A retrieval block with no outcome at all is still not a completed search.
    expect(readRetrievalStatus([{ retrieval: {} }])).toEqual({ kind: 'failed', outcome: 'unknown' });
  });

  it('reports no status writes at all as absent', () => {
    expect(readRetrievalStatus([])).toEqual({ kind: 'absent' });
    // A status write that carries no retrieval block does not count as the terminal one.
    expect(readRetrievalStatus([{ citables: [{ id: 'f1' }] }])).toEqual({ kind: 'absent' });
  });
});

describe('readServedDocuments', () => {
  it('reads a scored event as the files retrieval served', () => {
    expect(readServedDocuments({ fileIds: ['f1', 'f2'], scores: [0.81, 0.74] }, SERVED)).toEqual({
      kind: 'served',
      fileIds: ['f1', 'f2'],
    });
  });

  it('reads no event as having served nothing when the tool says it served nothing', () => {
    // The desired outcome on a negative question: the search produced no output, so the tool
    // recorded no lake read - and its own status write corroborates that.
    expect(readServedDocuments(null, EMPTY)).toEqual({ kind: 'nothing' });
    expect(readServedDocuments(undefined, EMPTY)).toEqual({ kind: 'nothing' });
  });

  it('refuses a missing event when the tool says content WAS served', () => {
    // The case a bare null cannot express: a stalled un-awaited audit write, or a hit on something
    // not attributable to a lake. Scoring it zero would look exactly like the floor working.
    const reading = readServedDocuments(null, SERVED);
    expect(reading.kind).toBe('unmeasurable');
    expect(reading).toMatchObject({ reason: expect.stringContaining('no lake-audit event') });
  });

  it('refuses a run whose retrieval never completed', () => {
    expect(readServedDocuments(null, { kind: 'failed', outcome: 'no_lakes' })).toMatchObject({
      kind: 'unmeasurable',
      reason: expect.stringContaining('no_lakes'),
    });
    expect(readServedDocuments(null, { kind: 'absent' })).toMatchObject({ kind: 'unmeasurable' });
  });

  it('reads a score-less event as the keyword fallback, not as a result', () => {
    // The keyword arm records the SAME surface with no chunk scores. Scoring it as a real result
    // would report a keyword-search number as a budget-sweep row, and neither knob applies there.
    expect(readServedDocuments({ fileIds: ['f1'] }, SERVED)).toEqual({ kind: 'keyword-fallback' });
    expect(readServedDocuments({ fileIds: ['f1'], scores: [] }, SERVED)).toEqual({ kind: 'keyword-fallback' });
  });

  it('refuses a scored event that carries no files rather than blaming the keyword arm', () => {
    // Should not occur - scores are index-aligned to the chunks those files came from - and it is
    // not the keyword arm either, which writes no scores at all. Diagnosing it as one would send
    // the operator after an embedding credential that is fine.
    expect(readServedDocuments({ fileIds: [], scores: [0.9] }, SERVED)).toMatchObject({ kind: 'unmeasurable' });
    expect(readServedDocuments({ scores: [0.9] }, SERVED)).toMatchObject({ kind: 'unmeasurable' });
  });

  it('does not treat a zero score as absent', () => {
    // 0 is a real cosine score. A truthiness check on scores[0] would misread this as the keyword arm.
    expect(readServedDocuments({ fileIds: ['f1'], scores: [0] }, SERVED)).toEqual({
      kind: 'served',
      fileIds: ['f1'],
    });
  });
});
