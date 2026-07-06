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

    it.each(['abc', '', '0', '-1'])('falls back to defaults when a var is %j', async raw => {
      vi.stubEnv('NEXT_PUBLIC_PRICE_MARGIN', raw);
      vi.stubEnv('NEXT_PUBLIC_USD_TO_CREDITS_RATE', raw);
      const pricing = await importPricing();
      expect(pricing.usdToCredits(1)).toBe(5000);
    });

    it('keeps the phantom-credit guard when values come from env', async () => {
      vi.stubEnv('NEXT_PUBLIC_PRICE_MARGIN', '3');
      vi.stubEnv('NEXT_PUBLIC_USD_TO_CREDITS_RATE', '0.0006');
      const pricing = await importPricing();
      expect(pricing.usdToCredits(10)).toBe(50000);
      expect(pricing.usdToCredits(100)).toBe(500000);
    });

    it('rejects partially numeric values instead of truncating them', async () => {
      // parseFloat would read "2,5" as 2 and silently bill at the wrong margin
      vi.stubEnv('NEXT_PUBLIC_PRICE_MARGIN', '2,5');
      const pricing = await importPricing();
      expect(pricing.usdToCredits(1)).toBe(5000);
    });

    it('falls back to defaults when the derived credits-per-USD would round to zero', async () => {
      // margin/rate rounds to 0, which would collapse every charge to 1 credit
      vi.stubEnv('NEXT_PUBLIC_USD_TO_CREDITS_RATE', '5000');
      const pricing = await importPricing();
      expect(pricing.usdToCredits(1)).toBe(5000);
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
