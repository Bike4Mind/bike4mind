import { describe, it, expect } from 'vitest';
import { usdToCredits } from '../pricing';

describe('pricing utils', () => {
  describe('usdToCredits', () => {
    it('should convert $1 USD to 5000 credits with markup', () => {
      expect(usdToCredits(1)).toBe(5000);
    });

    it('should convert $0.001 USD to 5 credits with markup', () => {
      expect(usdToCredits(0.001)).toBe(5);
    });

    it('should convert $0.0001 USD to 1 credit (minimum)', () => {
      expect(usdToCredits(0.0001)).toBe(1);
    });

    it('should round partial credits up', () => {
      // $0.00021 * 3 / 0.0006 = 1.05 -> 2 credits
      expect(usdToCredits(0.00021)).toBe(2);
    });

    it('should handle zero input by returning minimum 1 credit', () => {
      expect(usdToCredits(0)).toBe(1);
    });

    it('should handle negative input by returning minimum 1 credit', () => {
      expect(usdToCredits(-1)).toBe(1);
    });

    it('should handle large USD amounts correctly', () => {
      expect(usdToCredits(100)).toBe(500000);
    });

    it('should not overcharge from floating-point noise on exact multiples', () => {
      // Naive (usd * MARGIN) / RATE yields 500000.00000000006 for $100 and
      // 50000.00000000001 for $10; ceil would add a phantom credit.
      expect(usdToCredits(10)).toBe(50000);
      expect(usdToCredits(0.0002)).toBe(1);
    });
  });
});
