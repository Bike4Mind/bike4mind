// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { defaultFeedbackRollupWindow, FEEDBACK_ROLLUP_DEFAULT_WINDOW_DAYS } from './feedbackRollupWindow';

describe('defaultFeedbackRollupWindow', () => {
  /**
   * The identity check is the point, not a nicety: these strings go straight into the rollup query
   * key, so a helper that returned an equal-but-new pair on each call would still refetch forever.
   */
  it('returns the same bounds on every call', () => {
    expect(defaultFeedbackRollupWindow()).toBe(defaultFeedbackRollupWindow());
  });

  it('spans the documented number of days, ending now', () => {
    const { from, to } = defaultFeedbackRollupWindow();
    const spanDays = (new Date(to).getTime() - new Date(from).getTime()) / (24 * 60 * 60 * 1000);

    expect(spanDays).toBe(FEEDBACK_ROLLUP_DEFAULT_WINDOW_DAYS);
    expect(new Date(to).getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('emits bounds the server contract accepts (UTC ISO with an offset)', () => {
    const { from, to } = defaultFeedbackRollupWindow();

    expect(from).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(to).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});
