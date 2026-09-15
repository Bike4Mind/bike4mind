import { describe, expect, it } from 'vitest';
import { aggregate, hitRate, precision, recall, reciprocalRank, scoreQuestion } from './metrics';

const set = (...ids: string[]) => new Set(ids);

describe('recall', () => {
  it('is the fraction of the supporting set that was served', () => {
    expect(recall(['a', 'b'], set('a', 'b', 'c', 'd'))).toBe(0.5);
  });

  it('does not exceed 1 when extra non-supporting documents are served', () => {
    expect(recall(['a', 'x', 'y', 'z'], set('a'))).toBe(1);
  });

  it('is vacuously 1 on a negative question, which is why negatives are scored separately', () => {
    expect(recall([], set())).toBe(1);
    expect(recall(['x'], set())).toBe(1);
  });
});

describe('precision', () => {
  it('is the fraction of what was served that supports the answer', () => {
    expect(precision(['a', 'x', 'y', 'z'], set('a'))).toBe(0.25);
  });

  it('scores 1 for serving nothing, which is only meaningful next to recall', () => {
    expect(precision([], set('a'))).toBe(1);
    expect(recall([], set('a'))).toBe(0);
  });
});

describe('hitRate', () => {
  it('is 1 when any supporting document was served, regardless of how many were missed', () => {
    // The #1831 shape: finds something, then stops. High hit rate, low recall.
    expect(hitRate(['a'], set('a', 'b', 'c', 'd', 'e'))).toBe(1);
    expect(recall(['a'], set('a', 'b', 'c', 'd', 'e'))).toBe(0.2);
  });

  it('is 0 on a negative question so it cannot inflate the positives-only average', () => {
    expect(hitRate(['x'], set())).toBe(0);
  });
});

describe('reciprocalRank', () => {
  it('rewards serving a supporting document earlier', () => {
    expect(reciprocalRank(['a', 'x'], set('a'))).toBe(1);
    expect(reciprocalRank(['x', 'a'], set('a'))).toBe(0.5);
    expect(reciprocalRank(['x', 'y', 'a'], set('a'))).toBeCloseTo(1 / 3);
  });

  it('is 0 when no supporting document was served at all', () => {
    expect(reciprocalRank(['x', 'y'], set('a'))).toBe(0);
  });
});

describe('scoreQuestion', () => {
  it('counts a document once even when several of its passages were served', () => {
    // The probe maps passages to their owning document, so repeats are the normal case: a token
    // budget that admits 5 passages from one file has reached ONE document, not five.
    const outcome = scoreQuestion(['a', 'a', 'a', 'b'], set('a', 'b'));
    expect(outcome.documentsServed).toBe(2);
    expect(outcome.recall).toBe(1);
    expect(outcome.precision).toBe(1);
  });

  it('dedupes forward so reciprocal rank reflects first appearance', () => {
    expect(scoreQuestion(['x', 'a', 'x'], set('a')).rr).toBe(0.5);
  });

  it('flags a question with no supporting set as a negative', () => {
    expect(scoreQuestion(['x'], set()).isNegative).toBe(true);
    expect(scoreQuestion(['x'], set('a')).isNegative).toBe(false);
  });
});

describe('aggregate', () => {
  it('averages positives and negatives separately so negatives cannot inflate recall', () => {
    const outcomes = [
      scoreQuestion(['a'], set('a', 'b')), // positive: recall 0.5
      scoreQuestion(['x'], set()), // negative: recall vacuously 1
    ];
    const agg = aggregate(outcomes);
    expect(agg.positives).toBe(1);
    expect(agg.negatives).toBe(1);
    // Pooling would have reported 0.75 here, a number no positive question earned.
    expect(agg.recall).toBe(0.5);
  });

  it('reports falsePositiveRate as the share of negatives that served anything', () => {
    const agg = aggregate([
      scoreQuestion(['x'], set()), // floor let something through
      scoreQuestion([], set()), // floor held
    ]);
    expect(agg.falsePositiveRate).toBe(0.5);
  });

  it('averages documentsServed across every question, positives and negatives alike', () => {
    const agg = aggregate([scoreQuestion(['a', 'b'], set('a')), scoreQuestion(['x'], set())]);
    expect(agg.meanDocumentsServed).toBe(1.5);
  });

  it('excludes empty-served positives from precision so a floor cannot inflate it', () => {
    const agg = aggregate([
      scoreQuestion(['a', 'x'], set('a')), // served, precision 0.5
      scoreQuestion([], set('b')), // emptied by the floor: precision vacuously 1
    ]);
    // Pooling the vacuous 1 would report 0.75 - precision RISING as the floor empties questions,
    // which inverts the one metric that exists to price what a floor costs.
    expect(agg.precision).toBe(0.5);
    expect(agg.precisionScored).toBe(1);
    // Recall is where the emptied question is supposed to show up, and still does.
    expect(agg.recall).toBe(0.5);
  });

  it('reports precisionScored 0 rather than a precision no question earned', () => {
    // Every positive emptied. mean([]) is 0, which the table renders as "n/a (n=0)" so it does not
    // read as a measured collapse.
    const agg = aggregate([scoreQuestion([], set('a')), scoreQuestion([], set('b'))]);
    expect(agg.precisionScored).toBe(0);
    expect(agg.precision).toBe(0);
    expect(agg.recall).toBe(0);
  });

  it('returns zeroes rather than NaN when a bucket is empty', () => {
    // A corpus with no negatives must not report NaN for falsePositiveRate: the probe prints these
    // straight into a results table, and NaN there reads as a broken run rather than an empty bucket.
    const agg = aggregate([scoreQuestion(['a'], set('a'))]);
    expect(agg.negatives).toBe(0);
    expect(agg.falsePositiveRate).toBe(0);
    expect(agg.recall).toBe(1);
  });

  it('handles a completely empty run without dividing by zero', () => {
    const agg = aggregate([]);
    expect(agg).toMatchObject({ positives: 0, negatives: 0, recall: 0, falsePositiveRate: 0 });
  });
});
