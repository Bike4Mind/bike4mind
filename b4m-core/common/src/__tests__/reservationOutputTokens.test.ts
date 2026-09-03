import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { getTextModelCost, ModelBackend, type ModelInfo } from '../models';

/**
 * Pins the pre-flight credit hold for a premium model whose output cap is 128K.
 * Holding the full cap made the gate reject turns the holder could easily afford;
 * these numbers are the guard against that regressing.
 */
const PREMIUM_128K_MODEL: ModelInfo = {
  id: 'premium-128k' as ModelInfo['id'],
  type: 'text',
  name: 'Premium 128K',
  backend: ModelBackend.Anthropic,
  contextWindow: 200_000,
  max_tokens: 128_000,
  pricing: { 200_000: { input: 5 / 1_000_000, output: 25 / 1_000_000 } },
  supportsImageVariation: false,
};

/** Re-imports pricing so module-load env reads see platform defaults, not an ambient override. */
const importPricing = async () => {
  vi.resetModules();
  return await import('../pricing');
};

describe('pre-flight reservation output sizing', () => {
  let pricing: typeof import('../pricing');

  beforeAll(async () => {
    vi.stubEnv('NEXT_PUBLIC_PRICE_MARGIN', undefined);
    vi.stubEnv('NEXT_PUBLIC_USD_TO_CREDITS_RATE', undefined);
    pricing = await importPricing();
  });

  afterAll(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('caps the priced output at the reservation ceiling, not the requested max_tokens', () => {
    expect(pricing.reservationOutputTokens(128_000)).toBe(pricing.PREFLIGHT_RESERVATION_OUTPUT_TOKENS);
  });

  it('holds a larger ceiling for models that reason inside the output budget', () => {
    expect(pricing.reservationOutputTokens(128_000, true)).toBe(pricing.PREFLIGHT_RESERVATION_REASONING_OUTPUT_TOKENS);
    expect(pricing.PREFLIGHT_RESERVATION_REASONING_OUTPUT_TOKENS).toBeGreaterThan(
      pricing.PREFLIGHT_RESERVATION_OUTPUT_TOKENS
    );
    // Absolute pin: every other assertion on this constant is relative to itself,
    // so raising it toward the old ceiling would otherwise leave the suite green.
    expect(pricing.PREFLIGHT_RESERVATION_REASONING_OUTPUT_TOKENS).toBe(32_768);
  });

  it('never raises a request that asks for less than the ceiling', () => {
    expect(pricing.reservationOutputTokens(4096)).toBe(4096);
    expect(pricing.reservationOutputTokens(4096, true)).toBe(4096);
  });

  it('holds a few hundred credits on a 128K-cap premium turn instead of thousands', () => {
    const inputTokens = 20_000;
    const held = pricing.usdToCredits(
      getTextModelCost(PREMIUM_128K_MODEL, inputTokens, pricing.reservationOutputTokens(128_000))
    );
    const worstCase = pricing.usdToCredits(getTextModelCost(PREMIUM_128K_MODEL, inputTokens, 128_000));

    // 20K input at $5/1M + 16,384 output at $25/1M = $0.5096 -> 1020 credits,
    // against $3.30 -> 6601 for the full window (the odd credit is usdToCredits
    // rounding up float noise in 3.3 * 2000).
    expect(held).toBe(1020);
    expect(worstCase).toBe(6601);

    // The user this fixes: a balance that clears the realistic hold but not the cap.
    expect(held).toBeLessThan(4000);
    expect(worstCase).toBeGreaterThan(4000);
  });

  it('prices the settled turn on actual output, unaffected by the reservation ceiling', () => {
    // Settlement passes real usage, so a turn that runs past the ceiling still
    // bills its full COGS - the hold shrinks, the charge does not.
    const settled = getTextModelCost(PREMIUM_128K_MODEL, 20_000, 120_000);
    expect(settled).toBeCloseTo(0.1 + 3.0, 6);
    expect(pricing.usdToCredits(settled)).toBe(6200);
  });
});
