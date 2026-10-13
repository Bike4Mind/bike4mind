import { describe, it, expect } from 'vitest';
import { isPopularPlan } from './isPopularPlan';

describe('isPopularPlan', () => {
  it('is false when a single plan is rendered', () => {
    expect(isPopularPlan('Professional', 1)).toBe(false);
  });

  it('is false when nothing is rendered', () => {
    expect(isPopularPlan('Professional', 0)).toBe(false);
  });

  it('is true for the popular plan when several plans are rendered', () => {
    expect(isPopularPlan('Professional', 2)).toBe(true);
  });

  it('is false for other plans when several are rendered', () => {
    expect(isPopularPlan('Starter', 3)).toBe(false);
  });
});
