import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from 'vitest';

/** Re-imports pricing so module-load env reads see the stubbed vars. */
const importPricing = async () => {
  vi.resetModules();
  return await import('../pricing');
};

describe('pricing utils', () => {
  describe('usdToCredits', () => {
    // Isolate from ambient env: dev shells and CI may set these vars once the feature is in use.
    let usdToCredits: (usd: number) => number;

    beforeAll(async () => {
      vi.stubEnv('NEXT_PUBLIC_PRICE_MARGIN', undefined);
      vi.stubEnv('NEXT_PUBLIC_USD_TO_CREDITS_RATE', undefined);
      ({ usdToCredits } = await importPricing());
    });

    afterAll(() => {
      vi.unstubAllEnvs();
      vi.resetModules();
    });

    it('should convert $1 USD to 2000 credits with markup', () => {
      expect(usdToCredits(1)).toBe(2000);
    });

    it('should convert $0.001 USD to 2 credits with markup', () => {
      expect(usdToCredits(0.001)).toBe(2);
    });

    it('should convert $0.0001 USD to 1 credit (minimum)', () => {
      expect(usdToCredits(0.0001)).toBe(1);
    });

    it('should round partial credits up', () => {
      // $0.00055 * 1.2 / 0.0006 = 1.1 -> 2 credits
      expect(usdToCredits(0.00055)).toBe(2);
    });

    it('should handle zero input by returning minimum 1 credit', () => {
      expect(usdToCredits(0)).toBe(1);
    });

    it('should handle negative input by returning minimum 1 credit', () => {
      expect(usdToCredits(-1)).toBe(1);
    });

    it('should handle large USD amounts correctly', () => {
      expect(usdToCredits(100)).toBe(200000);
    });

    it('should not overcharge from floating-point noise on exact multiples', () => {
      // Naive (usd * MARGIN) / RATE carries float noise (0.0006 is inexact
      // in binary); ceil would add a phantom credit on exact multiples.
      expect(usdToCredits(10)).toBe(20000);
      expect(usdToCredits(0.0005)).toBe(1);
    });

    it('uses the platform default rate when no override is passed', () => {
      expect(usdToCredits(1)).toBe(2000);
    });

    it('uses an explicit rate override instead of the platform default', () => {
      expect(usdToCredits(1, 5000)).toBe(5000);
      expect(usdToCredits(0.5, 100)).toBe(50);
    });

    it('still applies the minimum-1-credit floor with an overridden rate', () => {
      expect(usdToCredits(0.00001, 100)).toBe(1);
    });
  });

  describe('usdToCreditsStochastic', () => {
    let usdToCreditsStochastic: (usd: number, rng?: () => number) => number;

    beforeAll(async () => {
      vi.stubEnv('NEXT_PUBLIC_PRICE_MARGIN', undefined);
      vi.stubEnv('NEXT_PUBLIC_USD_TO_CREDITS_RATE', undefined);
      ({ usdToCreditsStochastic } = await importPricing());
    });

    afterAll(() => {
      vi.unstubAllEnvs();
      vi.resetModules();
    });

    it('charges the exact integer for whole-credit costs regardless of the draw', () => {
      // $1 = exactly 2000 credits; fraction is 0 so the rng must not matter
      expect(usdToCreditsStochastic(1, () => 0)).toBe(2000);
      expect(usdToCreditsStochastic(1, () => 0.999999)).toBe(2000);
    });

    it('rounds the fraction up when the draw lands below it', () => {
      // $0.00055 -> 1.1 raw credits; draw 0.05 < 0.1 -> round up
      expect(usdToCreditsStochastic(0.00055, () => 0.05)).toBe(2);
    });

    it('rounds the fraction down when the draw lands at or above it', () => {
      // $0.00055 -> 1.1 raw credits; draw 0.5 >= 0.1 -> keep floor
      expect(usdToCreditsStochastic(0.00055, () => 0.5)).toBe(1);
    });

    it('can legitimately charge zero for sub-credit costs', () => {
      // $0.0001 -> 0.2 raw credits; draw 0.9 -> 0 (no 1-credit minimum)
      expect(usdToCreditsStochastic(0.0001, () => 0.9)).toBe(0);
      // ...and 1 when the draw lands inside the fraction
      expect(usdToCreditsStochastic(0.0001, () => 0.1)).toBe(1);
    });

    it('charges zero for zero, negative, and non-finite costs', () => {
      expect(usdToCreditsStochastic(0, () => 0)).toBe(0);
      expect(usdToCreditsStochastic(-1, () => 0)).toBe(0);
      expect(usdToCreditsStochastic(Number.NaN, () => 0)).toBe(0);
    });

    it('is unbiased: the expected charge equals the exact fractional cost', () => {
      // Deterministic low-discrepancy sequence over [0,1) instead of a real
      // RNG so the test cannot flake; 0.2 raw credits should average ~0.2.
      const N = 10000;
      let draws = 0;
      const rng = () => {
        draws += 1;
        return (draws - 0.5) / N;
      };
      let total = 0;
      for (let i = 0; i < N; i++) {
        total += usdToCreditsStochastic(0.0001, rng); // 0.2 raw credits
      }
      expect(total / N).toBeCloseTo(0.2, 10);
    });

    it('defaults to a working rng when none is injected', () => {
      const charge = usdToCreditsStochastic(0.0001);
      expect(charge === 0 || charge === 1).toBe(true);
    });

    it('uses an explicit rate override instead of the platform default', () => {
      // $1 * 100 rate = exactly 100 credits; fraction is 0 so rng must not matter
      expect(usdToCreditsStochastic(1, () => 0, 100)).toBe(100);
      expect(usdToCreditsStochastic(1, () => 0.999999, 100)).toBe(100);
    });

    it('rounds a fractional charge correctly under an overridden rate', () => {
      // $0.011 * 100 rate = 1.1 raw credits; draw 0.05 < 0.1 -> round up
      expect(usdToCreditsStochastic(0.011, () => 0.05, 100)).toBe(2);
      // draw 0.5 >= 0.1 -> keep floor
      expect(usdToCreditsStochastic(0.011, () => 0.5, 100)).toBe(1);
    });
  });

  describe('CREDITS_PER_USD_COST export', () => {
    afterEach(() => {
      vi.unstubAllEnvs();
      vi.resetModules();
    });

    it('is exported and matches the default rate used by usdToCredits', async () => {
      vi.stubEnv('NEXT_PUBLIC_PRICE_MARGIN', undefined);
      vi.stubEnv('NEXT_PUBLIC_USD_TO_CREDITS_RATE', undefined);
      const pricing = await importPricing();
      expect(pricing.CREDITS_PER_USD_COST).toBe(2000);
      expect(pricing.usdToCredits(1)).toBe(pricing.CREDITS_PER_USD_COST);
    });

    it('reflects env overrides so downstream seeds (e.g. an admin setting default) stay in sync', async () => {
      vi.stubEnv('NEXT_PUBLIC_PRICE_MARGIN', '2');
      vi.stubEnv('NEXT_PUBLIC_USD_TO_CREDITS_RATE', '0.001');
      const pricing = await importPricing();
      expect(pricing.CREDITS_PER_USD_COST).toBe(2000);
    });
  });

  describe('env-configured valuation', () => {
    afterEach(() => {
      vi.unstubAllEnvs();
      vi.resetModules();
    });

    it('uses NEXT_PUBLIC_PRICE_MARGIN and NEXT_PUBLIC_USD_TO_CREDITS_RATE when set', async () => {
      vi.stubEnv('NEXT_PUBLIC_PRICE_MARGIN', '2');
      vi.stubEnv('NEXT_PUBLIC_USD_TO_CREDITS_RATE', '0.001');
      const pricing = await importPricing();
      expect(pricing.usdToCredits(1)).toBe(2000);
    });

    it('overrides one knob independently of the other', async () => {
      vi.stubEnv('NEXT_PUBLIC_PRICE_MARGIN', '6');
      const pricing = await importPricing();
      // margin 6 over the default $0.0006/credit rate
      expect(pricing.usdToCredits(1)).toBe(10000);
    });

    it('restores the previous 3x policy via env (self-host escape hatch)', async () => {
      vi.stubEnv('NEXT_PUBLIC_PRICE_MARGIN', '3');
      const pricing = await importPricing();
      expect(pricing.usdToCredits(1)).toBe(5000);
    });

    it.each(['abc', '', '0', '-1'])('falls back to defaults when a var is %j', async raw => {
      vi.stubEnv('NEXT_PUBLIC_PRICE_MARGIN', raw);
      vi.stubEnv('NEXT_PUBLIC_USD_TO_CREDITS_RATE', raw);
      const pricing = await importPricing();
      expect(pricing.usdToCredits(1)).toBe(2000);
    });

    it('keeps the phantom-credit guard when values come from env', async () => {
      vi.stubEnv('NEXT_PUBLIC_PRICE_MARGIN', '1.2');
      vi.stubEnv('NEXT_PUBLIC_USD_TO_CREDITS_RATE', '0.0006');
      const pricing = await importPricing();
      expect(pricing.usdToCredits(10)).toBe(20000);
      expect(pricing.usdToCredits(100)).toBe(200000);
    });

    it('rejects partially numeric values instead of truncating them', async () => {
      // parseFloat would read "2,5" as 2 and silently bill at the wrong margin
      vi.stubEnv('NEXT_PUBLIC_PRICE_MARGIN', '2,5');
      const pricing = await importPricing();
      expect(pricing.usdToCredits(1)).toBe(2000);
    });

    it('falls back to defaults when the derived credits-per-USD would round to zero', async () => {
      // margin/rate rounds to 0, which would collapse every charge to 1 credit
      vi.stubEnv('NEXT_PUBLIC_USD_TO_CREDITS_RATE', '5000');
      const pricing = await importPricing();
      expect(pricing.usdToCredits(1)).toBe(2000);
    });

    it('warns when a set override is rejected', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.stubEnv('NEXT_PUBLIC_PRICE_MARGIN', 'abc');
      await importPricing();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('NEXT_PUBLIC_PRICE_MARGIN'));
      warn.mockRestore();
    });

    it('does not warn when the vars are simply unset', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.stubEnv('NEXT_PUBLIC_PRICE_MARGIN', undefined);
      vi.stubEnv('NEXT_PUBLIC_USD_TO_CREDITS_RATE', undefined);
      await importPricing();
      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
    });
  });
});
