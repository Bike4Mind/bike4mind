// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { defaultFeedbackRollupWindow, FEEDBACK_ROLLUP_DEFAULT_WINDOW_DAYS } from './feedbackRollupWindow';

const MINUTE_MS = 60 * 1000;
const base = Date.parse('2026-10-15T12:01:30.000Z');

describe('defaultFeedbackRollupWindow', () => {
  /**
   * The identity check is the point, not a nicety: these strings go straight into the rollup query
   * key, so a helper that returned an equal-but-new pair on each call would still refetch forever.
   */
  it('returns the same bounds on every call within one 5-minute step', () => {
    const first = defaultFeedbackRollupWindow(base);
    expect(defaultFeedbackRollupWindow(base + 2 * MINUTE_MS)).toBe(first);
    expect(first.to).toBe('2026-10-15T12:05:00.000Z');
  });

  it('advances past the step, so feedback filed after app load falls inside the window', () => {
    const before = defaultFeedbackRollupWindow(base);
    const filedAt = base + 10 * MINUTE_MS;
    const after = defaultFeedbackRollupWindow(filedAt);

    expect(after).not.toBe(before);
    expect(Date.parse(after.to)).toBeGreaterThanOrEqual(filedAt);
    expect(Date.parse(before.to)).toBeLessThan(filedAt);
  });

  it('spans the documented number of days, ending at or after now', () => {
    const now = Date.now();
    const { from, to } = defaultFeedbackRollupWindow(now);
    const spanDays = (new Date(to).getTime() - new Date(from).getTime()) / (24 * 60 * 60 * 1000);

    expect(spanDays).toBe(FEEDBACK_ROLLUP_DEFAULT_WINDOW_DAYS);
    expect(new Date(to).getTime()).toBeGreaterThanOrEqual(now);
    expect(new Date(to).getTime() - now).toBeLessThanOrEqual(5 * MINUTE_MS);
  });

  it('emits bounds the server contract accepts (UTC ISO with an offset)', () => {
    const { from, to } = defaultFeedbackRollupWindow();

    expect(from).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(to).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});
