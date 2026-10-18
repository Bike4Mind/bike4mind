import { describe, it, expect } from 'vitest';
import { formatPlanPrice, pricePerThousandCredits, sharedPackRate } from './billingFormat';

describe('billingFormat', () => {
  it('drops cents only for whole-dollar prices', () => {
    expect(formatPlanPrice(30)).toBe('$30');
    expect(formatPlanPrice(12.5)).toBe('$12.50');
  });

  it('prices 1,000 credits to the cent', () => {
    expect(pricePerThousandCredits(10, 16667)).toBe('$0.60');
    expect(pricePerThousandCredits(20, 33333)).toBe('$0.60');
  });

  it('reports one shared rate only when every pack has it', () => {
    expect(
      sharedPackRate([
        { price: 10, credits: 16667 },
        { price: 35, credits: 58333 },
      ])
    ).toBe('$0.60');
    expect(
      sharedPackRate([
        { price: 10, credits: 16667 },
        { price: 30, credits: 60000 },
      ])
    ).toBeNull();
  });
});
