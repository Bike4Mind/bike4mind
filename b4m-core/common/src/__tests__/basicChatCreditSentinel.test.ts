import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import {
  getTextModelCost,
  CACHE_READ_MULTIPLIER,
  CACHE_WRITE_MULTIPLIER,
  ModelBackend,
  type ModelInfo,
} from '../models';

/**
 * Credit-cost sentinel for a canonical basic chat turn (Bike4Mind/bike4mind#812).
 *
 * WHY THIS EXISTS: a prompt-composition change once silently ~doubled the
 * cold-turn token footprint (and thus the credit cost) of a basic chat, and
 * nothing in CI caught it - QA found it in production. This test pins the whole
 * cost pipeline (default-model pricing -> cache math -> markup -> credit rate)
 * against the economics measured and documented in the tracking epic, so any
 * change that moves the number becomes a loud, deliberate edit here instead of
 * silent drift.
 *
 * WHAT IT DOES NOT COVER: the *assembled prompt's real token count* is measured
 * server-side inside ChatCompletionProcess and is not deterministically
 * reconstructable offline. Guarding that against a budget depends on the
 * per-section payload capture in Bike4Mind/bike4mind#810; when that lands, add a
 * companion assertion that the real always-on prefix stays under
 * COLD_PROMPT_TOKEN_BUDGET below. Until then this pins the cost model, and the
 * token composition here is the documented baseline the cost is derived from.
 */

// Re-import pricing after stubbing env so the module-load reads (PRICE_MARGIN,
// USD_TO_CREDITS_RATE, CREDITS_PER_USD_COST) see platform defaults, not an
// ambient dev/CI override. Mirrors pricing.test.ts.
const importPricing = async () => {
  vi.resetModules();
  return await import('../pricing');
};

/**
 * Default model's published pricing, mirrored from
 * b4m-core/llm-adapters/src/anthropicBackend.ts (CLAUDE_5_SONNET): $3/$15 per
 * 1M, single 1M-context tier. `common` cannot import the adapter (dependency
 * direction), so this is a deliberate copy - if the adapter price changes,
 * update it here and re-baseline the expectations below on purpose.
 */
const DEFAULT_MODEL: ModelInfo = {
  id: 'claude-sonnet-5' as ModelInfo['id'],
  type: 'text',
  name: 'Claude 5 Sonnet',
  backend: ModelBackend.Anthropic,
  contextWindow: 1_000_000,
  max_tokens: 128_000,
  pricing: { 1_000_000: { input: 3 / 1_000_000, output: 15 / 1_000_000 } },
  supportsImageVariation: false,
};

/**
 * Canonical basic cold turn, measured on a preview (see the epic's data table):
 * a trivial one-line prompt in a fresh chat writes the always-on prompt prefix
 * to the provider cache, leaving a tiny uncached tail. ~99% of the cost is the
 * prefix cache-write, so we pin the prompt/input side and hold output at 0 -
 * answer generation is response-dependent and is not the footprint that creeps.
 */
const COLD_CACHE_CREATION_TOKENS = 7_798; // always-on prefix written to cache
const COLD_UNCACHED_INPUT_TOKENS = 2; // uncached tail (actualInputTokens)
const COLD_CACHE_READ_TOKENS = 0; // nothing to read back on a cold turn
const COLD_OUTPUT_TOKENS = 0; // pin the prompt footprint, not the variable answer

/**
 * Footprint budget. Baseline is ~7,798 cache-write tokens; 8,500 leaves modest
 * headroom for benign wording tweaks. Raising this is a deliberate decision to
 * accept a larger always-on prompt - do it only with the COGS/product
 * justification the epic requires, not to make a red build green.
 */
const COLD_PROMPT_TOKEN_BUDGET = 8_500;

// Documented baseline the epic reported for this exact composition.
const EXPECTED_COLD_COGS_USD = 0.0292485;
const EXPECTED_COLD_CREDITS_FLOOR = 58; // stochastic floor == the epic's "58 cr"
const EXPECTED_COLD_CREDITS_CEIL = 59; // deterministic round-up (reservation side)

describe('basic-chat credit sentinel (#812)', () => {
  let usdToCredits: (usd: number) => number;
  let usdToCreditsStochastic: (usd: number, rng?: () => number) => number;
  let CREDITS_PER_USD_COST: number;
  let getPriceMargin: () => number;

  beforeAll(async () => {
    vi.stubEnv('NEXT_PUBLIC_PRICE_MARGIN', undefined);
    vi.stubEnv('NEXT_PUBLIC_USD_TO_CREDITS_RATE', undefined);
    ({ usdToCredits, usdToCreditsStochastic, CREDITS_PER_USD_COST, getPriceMargin } = await importPricing());
  });

  afterAll(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  describe('pinned economic constants (change == deliberate edit)', () => {
    it('holds the platform markup at 1.2x', () => {
      expect(getPriceMargin()).toBe(1.2);
    });

    it('holds the credit valuation at 2000 credits per $1 of COGS', () => {
      expect(CREDITS_PER_USD_COST).toBe(2000);
    });

    it('holds the Anthropic cache multipliers (0.1x read, 1.25x write)', () => {
      expect(CACHE_READ_MULTIPLIER).toBe(0.1);
      expect(CACHE_WRITE_MULTIPLIER).toBe(1.25);
    });

    it('holds the default model pricing at $3/$15 per 1M', () => {
      expect(DEFAULT_MODEL.pricing[1_000_000]).toEqual({
        input: 3 / 1_000_000,
        output: 15 / 1_000_000,
      });
    });
  });

  describe('canonical cold turn', () => {
    it('keeps the always-on prompt footprint under budget', () => {
      expect(COLD_CACHE_CREATION_TOKENS).toBeLessThanOrEqual(COLD_PROMPT_TOKEN_BUDGET);
    });

    it('costs the documented provider COGS (~$0.0292, ~99% prefix cache-write)', () => {
      const cost = getTextModelCost(
        DEFAULT_MODEL,
        COLD_UNCACHED_INPUT_TOKENS,
        COLD_OUTPUT_TOKENS,
        COLD_CACHE_READ_TOKENS,
        COLD_CACHE_CREATION_TOKENS
      );
      expect(cost).toBeCloseTo(EXPECTED_COLD_COGS_USD, 6);
    });

    it('settles at the documented ~58 credits (stochastic floor / round-up)', () => {
      const cost = getTextModelCost(
        DEFAULT_MODEL,
        COLD_UNCACHED_INPUT_TOKENS,
        COLD_OUTPUT_TOKENS,
        COLD_CACHE_READ_TOKENS,
        COLD_CACHE_CREATION_TOKENS
      );
      // raw credits = 58.497: floors to 58 when the draw lands at/above the
      // fraction, rounds to 59 below it; reservation (usdToCredits) always ceils.
      expect(usdToCreditsStochastic(cost, () => 0.999999)).toBe(EXPECTED_COLD_CREDITS_FLOOR);
      expect(usdToCreditsStochastic(cost, () => 0)).toBe(EXPECTED_COLD_CREDITS_CEIL);
      expect(usdToCredits(cost)).toBe(EXPECTED_COLD_CREDITS_CEIL);
    });

    it('is unbiased in expectation at ~58.5 credits over many settlements', () => {
      const cost = getTextModelCost(
        DEFAULT_MODEL,
        COLD_UNCACHED_INPUT_TOKENS,
        COLD_OUTPUT_TOKENS,
        COLD_CACHE_READ_TOKENS,
        COLD_CACHE_CREATION_TOKENS
      );
      // Low-discrepancy sweep over [0,1) so the mean can't flake (mirrors pricing.test.ts).
      const N = 10_000;
      let draws = 0;
      const rng = () => {
        draws += 1;
        return (draws - 0.5) / N;
      };
      let total = 0;
      for (let i = 0; i < N; i++) total += usdToCreditsStochastic(cost, rng);
      expect(total / N).toBeCloseTo(58.497, 2);
    });
  });
});
