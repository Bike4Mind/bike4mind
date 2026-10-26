// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { resolveSubscriptionCycleCredits } from './cycleCredits';

describe('resolveSubscriptionCycleCredits', () => {
  it('uses the plan default unless an override is present', () => {
    expect(resolveSubscriptionCycleCredits(50000)).toBe(50000);
    expect(resolveSubscriptionCycleCredits(50000, 75000)).toBe(75000);
    expect(resolveSubscriptionCycleCredits(undefined, 75000)).toBe(75000);
  });

  it.each([0, -1, NaN, Infinity])('rejects invalid credits %s without borrowing the default', credits => {
    expect(resolveSubscriptionCycleCredits(50000, credits)).toBeNull();
    expect(resolveSubscriptionCycleCredits(credits)).toBeNull();
  });

  it('keeps an unstated grant unknown', () => {
    expect(resolveSubscriptionCycleCredits(undefined)).toBeNull();
  });
});
