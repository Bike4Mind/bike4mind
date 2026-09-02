import { describe, expect, it } from 'vitest';
import { readServedDocuments } from './auditEvent';

describe('readServedDocuments', () => {
  it('reads a scored event as the files retrieval served', () => {
    expect(readServedDocuments({ fileIds: ['f1', 'f2'], scores: [0.81, 0.74] })).toEqual({
      kind: 'served',
      fileIds: ['f1', 'f2'],
    });
  });

  it('reads no event as having served nothing', () => {
    // The desired outcome on a negative question: the search produced no output, so the tool
    // recorded no lake read.
    expect(readServedDocuments(null)).toEqual({ kind: 'nothing' });
    expect(readServedDocuments(undefined)).toEqual({ kind: 'nothing' });
  });

  it('reads a score-less event as the keyword fallback, not as a result', () => {
    // The keyword arm records the SAME surface with no chunk scores. Scoring it as a real result
    // would report a keyword-search number as a budget-sweep row, and neither knob applies there.
    expect(readServedDocuments({ fileIds: ['f1'] })).toEqual({ kind: 'keyword-fallback' });
    expect(readServedDocuments({ fileIds: ['f1'], scores: [] })).toEqual({ kind: 'keyword-fallback' });
  });

  it('refuses a scored event that carries no files rather than scoring it as an honest zero', () => {
    // Should not occur - scores are index-aligned to the chunks those files came from - but reading
    // it as 'served' with an empty list would silently score a broken run as a zero-recall question.
    expect(readServedDocuments({ fileIds: [], scores: [0.9] })).toEqual({ kind: 'keyword-fallback' });
    expect(readServedDocuments({ scores: [0.9] })).toEqual({ kind: 'keyword-fallback' });
  });

  it('does not treat a zero score as absent', () => {
    // 0 is a real cosine score. A truthiness check on scores[0] would misread this as the keyword arm.
    expect(readServedDocuments({ fileIds: ['f1'], scores: [0] })).toEqual({ kind: 'served', fileIds: ['f1'] });
  });
});
