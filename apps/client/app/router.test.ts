import { describe, it, expect } from 'vitest';
import { feedbackRollupRoute } from './router';
import { defaultFeedbackRollupWindow } from './utils/feedbackRollupWindow';

// validateSearch is what makes a bare /feedback/rollup URL load at all (see the route's own
// comment) - rollup.test.tsx mocks '@client/app/router' wholesale, so this is the only place the
// fallback branches actually run.
describe('feedbackRollupRoute validateSearch', () => {
  it('fills both bounds from the default window when the search is empty', () => {
    const fallback = defaultFeedbackRollupWindow();
    const result = feedbackRollupRoute.options.validateSearch({});

    expect(result.from).toBe(fallback.from);
    expect(result.to).toBe(fallback.to);
  });

  it('fills both bounds from the default window when the search carries garbage', () => {
    const fallback = defaultFeedbackRollupWindow();
    const result = feedbackRollupRoute.options.validateSearch({ from: 123, to: '' });

    expect(result.from).toBe(fallback.from);
    expect(result.to).toBe(fallback.to);
  });

  it('keeps a valid caller-supplied window instead of the default', () => {
    const result = feedbackRollupRoute.options.validateSearch({
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-02-01T00:00:00.000Z',
    });

    expect(result).toEqual({ from: '2026-01-01T00:00:00.000Z', to: '2026-02-01T00:00:00.000Z' });
  });
});
