import { describe, expect, it } from 'vitest';
import { aggregate, hitRateAtK, precisionAtK, recallAtK, reciprocalRank, scoreNegatives, scoreQuery } from './metrics';

const rel = (...ids: string[]) => new Set(ids);

describe('retrieval metrics', () => {
  it('hitRateAtK asks only whether the model SAW a relevant belief', () => {
    expect(hitRateAtK(['a', 'b', 'c'], rel('c'), 3)).toBe(1);
    expect(hitRateAtK(['a', 'b', 'c'], rel('c'), 2)).toBe(0); // fell outside the window
    expect(hitRateAtK([], rel('c'), 10)).toBe(0);
  });

  it('recallAtK is the share of relevant beliefs surfaced', () => {
    expect(recallAtK(['a', 'b'], rel('a', 'b'), 10)).toBe(1);
    expect(recallAtK(['a', 'x'], rel('a', 'b'), 10)).toBe(0.5);
    expect(recallAtK(['x'], rel(), 10)).toBe(1); // nothing to find: vacuously perfect
  });

  it('precisionAtK punishes injecting irrelevant memory', () => {
    expect(precisionAtK(['a'], rel('a'), 10)).toBe(1);
    // the top-k-regardless policy: one relevant belief, nine distractors
    expect(precisionAtK(['a', 'x', 'y', 'z'], rel('a'), 10)).toBe(0.25);
    expect(precisionAtK([], rel('a'), 10)).toBe(1); // injected nothing => injected nothing irrelevant
  });

  it('reciprocalRank rewards putting the right belief first', () => {
    expect(reciprocalRank(['a', 'b'], rel('a'))).toBe(1);
    expect(reciprocalRank(['b', 'a'], rel('a'))).toBe(0.5);
    expect(reciprocalRank(['b', 'c'], rel('a'))).toBe(0);
  });

  it('scoreQuery + aggregate summarise a run', () => {
    const outcomes = [scoreQuery(['a', 'x'], rel('a'), 10), scoreQuery(['y', 'b'], rel('b'), 10)];
    const agg = aggregate(outcomes);

    expect(agg.n).toBe(2);
    expect(agg.hitRate).toBe(1); // both found their target
    expect(agg.mrr).toBe(0.75); // ranks 1 and 2 => (1 + 0.5) / 2
    expect(agg.precision).toBe(0.5); // half of what was injected was relevant
    expect(agg.meanInjected).toBe(2);
  });

  it('scoreNegatives prices the confabulation risk directly', () => {
    // A policy with a real topicality floor stays quiet when nothing is relevant...
    expect(scoreNegatives([0, 0, 0])).toEqual({ n: 3, falseInjectionRate: 0, meanInjected: 0 });
    // ...while a top-k-regardless policy hands the model a distractor every single time.
    expect(scoreNegatives([10, 10, 10])).toEqual({ n: 3, falseInjectionRate: 1, meanInjected: 10 });
  });
});
