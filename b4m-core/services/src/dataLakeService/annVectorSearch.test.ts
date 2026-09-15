import { describe, expect, it } from 'vitest';
import { slowestAnnQueryMs } from './annVectorSearch';

describe('slowestAnnQueryMs', () => {
  // The load-bearing assertion in this file. A search queries its primary model and every
  // alternate model concurrently, so the natural-looking `reduce((a, b) => a + b)` would report
  // 700ms for a search whose ANN phase took 400 - and it would do so plausibly, tracking real
  // latency closely enough that nobody would question the alarm it eventually trips.
  it('takes the maximum, never the sum, because the queries run concurrently', () => {
    expect(slowestAnnQueryMs([100, 400, 200])).toBe(400);
  });

  // Not a hypothetical: a model whose query embed fails, or that had no eligible files, returns
  // null. Coerced to 0 it would still lose to the max here, but `Math.max()` of an all-null
  // search would return -Infinity and publish a negative duration - so the filter has to come
  // before the max, not be folded into it.
  it('ignores models that never reached the backend', () => {
    expect(slowestAnnQueryMs([null, 250, null])).toBe(250);
  });

  // The distinction the metric emitter depends on: null means "no query to report", which must
  // stay out of the latency population entirely rather than entering it as an instant query.
  it('returns null when no query reached a backend at all', () => {
    expect(slowestAnnQueryMs([])).toBeNull();
    expect(slowestAnnQueryMs([null, null])).toBeNull();
  });

  // 0 is a real measurement (a sub-millisecond response), and is NOT the same as null. A falsy
  // check anywhere along this path would collapse the two and drop a genuine datapoint.
  it('treats a zero-millisecond query as an observation, not as an absent one', () => {
    expect(slowestAnnQueryMs([0])).toBe(0);
    expect(slowestAnnQueryMs([null, 0])).toBe(0);
  });
});
