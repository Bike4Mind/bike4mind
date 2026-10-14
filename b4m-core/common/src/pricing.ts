import { CACHE_READ_MULTIPLIER, ModelBackend, pricingTierForTokens, type ModelInfo } from './models';
import { stripBedrockRegionPrefix } from './modelCatalog';

const DEFAULT_PRICE_MARGIN = 1.2;
const DEFAULT_USD_TO_CREDITS_RATE = 0.0006;

/**
 * Env override: strict positive finite Number only ("2,5" is rejected,
 * not truncated to 2; zero or negative would bill free or negative).
 * Warns on rejected values; unset stays silent.
 */
const envNumber = (name: string, raw: string | undefined, fallback: number): number => {
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  console.warn(`[pricing] Ignoring invalid ${name}="${raw}"; using default ${fallback}`);
  return fallback;
};

// Literal process.env.NEXT_PUBLIC_* access is required for Next.js to inline
// the values into the client bundle (see constants/dataLakes.ts); the typeof
// guard keeps non-Next browser bundles (no process global) importable.
const hasProcess = typeof process !== 'undefined';

/**
 * Target markup multiple over provider COGS (1.2 = charge 20% over what the
 * provider bills us). Deliberately thin: the markup covers provider price
 * wobble; payment fees and infrastructure are absorbed by the business.
 * Self-hosters can restore the previous policy with NEXT_PUBLIC_PRICE_MARGIN=3.
 */
const PRICE_MARGIN = envNumber(
  'NEXT_PUBLIC_PRICE_MARGIN',
  hasProcess ? process.env.NEXT_PUBLIC_PRICE_MARGIN : undefined,
  DEFAULT_PRICE_MARGIN
);

/** The resolved markup multiple (env override or default). Exported for
 * read-side displays that need the break-even boundary (target / margin). */
export const getPriceMargin = (): number => PRICE_MARGIN;

/**
 * What a credit sells for. Every purchase route (credit packages and
 * subscriptions) grants credits at this same uniform rate, so every buyer
 * experiences exactly PRICE_MARGIN over COGS. Keep the grant amounts in
 * apps/client/lib/credits/constants.ts and lib/userSubscriptions/constants.ts
 * consistent with this rate when repricing.
 */
const USD_TO_CREDITS_RATE = envNumber(
  'NEXT_PUBLIC_USD_TO_CREDITS_RATE',
  hasProcess ? process.env.NEXT_PUBLIC_USD_TO_CREDITS_RATE : undefined,
  DEFAULT_USD_TO_CREDITS_RATE
);

/**
 * Integer credits charged per $1 of provider cost. Derived once with rounding
 * because the raw division carries float noise (0.0006 is inexact in binary):
 * naive ceil((usd * 3) / 0.0006) charges a phantom credit on exact multiples.
 * Guarded because individually valid env values can still derive 0
 * (margin/rate < 0.5), collapsing every charge to the 1-credit minimum.
 *
 * Exported so callers that need an admin-tunable rate anchored to the
 * platform-wide default (e.g. an admin-settable per-provider override) can
 * seed from this value instead of duplicating the markup math.
 */
export const CREDITS_PER_USD_COST = (() => {
  const derived = Math.round(PRICE_MARGIN / USD_TO_CREDITS_RATE);
  if (Number.isFinite(derived) && derived >= 1) return derived;
  console.warn(`[pricing] Env-configured margin/rate derive ${derived} credits per USD cost; using defaults`);
  return Math.round(DEFAULT_PRICE_MARGIN / DEFAULT_USD_TO_CREDITS_RATE);
})();

/**
 * Converts a USD cost to credits, including markup, rounding UP (minimum 1).
 *
 * Use for reservations, eligibility checks, estimates, and display - anywhere
 * a deterministic, conservative number is needed. Final settlement of variable
 * usage should use usdToCreditsStochastic so users pay the exact fraction in
 * expectation instead of the round-up.
 *
 * Examples (defaults):
 * $1 USD = 2000 credits (1.2x markup at $0.0006/credit)
 * $0.001 USD = 2 credits
 * $0.0001 USD = 1 credit (minimum)
 *
 * @param rate - Credits per $1, defaults to the platform-wide CREDITS_PER_USD_COST.
 *   Pass an override for a provider-specific admin-tunable rate (e.g. a
 *   billing-sensitive external compute path priced independently of the
 *   platform default).
 */
export const usdToCredits = (usd: number, rate: number = CREDITS_PER_USD_COST): number => {
  return Math.max(1, Math.ceil(usd * rate));
};

/**
 * Uniform draw in [0, 1) from the platform CSPRNG. Billing draws MUST be
 * unpredictable: a caller who can foresee the stream could time requests to
 * land on the no-charge side of every draw. Node >= 19 and all browsers
 * expose globalThis.crypto; the Math.random fallback exists only so tests
 * and exotic runtimes do not crash, and it warns once.
 */
let warnedNonCryptoRng = false;
const cryptoUniform = (): number => {
  // Structural type: the DOM Crypto type is unavailable in this package's tsconfig lib
  const cryptoObj = (globalThis as { crypto?: { getRandomValues?: (buf: Uint32Array) => Uint32Array } }).crypto;
  if (cryptoObj?.getRandomValues) {
    const buf = new Uint32Array(1);
    cryptoObj.getRandomValues(buf);
    return buf[0] / 0x1_0000_0000;
  }
  if (!warnedNonCryptoRng) {
    warnedNonCryptoRng = true;
    console.warn('[pricing] globalThis.crypto unavailable; billing rounding falls back to Math.random');
  }
  return Math.random();
};

/**
 * Converts a USD cost to credits with markup using UNBIASED stochastic
 * rounding: the integer part is always charged, and the fractional part
 * charges one extra credit with probability equal to the fraction.
 * E[charge] equals the exact fractional cost at every call size - no
 * round-up overcharge, no 1-credit minimum, and no free-below-threshold
 * leak. Because draws are independent and priced at exact cost, no calling
 * pattern (splitting, retrying, aborting) changes expected cost.
 *
 * Server-side settlement only. Do NOT use for display, estimates, or
 * reservations (it is non-deterministic; use usdToCredits). Zero or
 * non-finite cost charges 0.
 *
 * @param usd - The raw provider cost in USD to convert
 * @param rng - Uniform [0,1) source, injectable for tests; defaults to CSPRNG
 * @param rate - Credits per $1, defaults to the platform-wide CREDITS_PER_USD_COST.
 *   Callers settling a provider-specific admin-tunable rate must pass the SAME
 *   rate value that was used at reservation time (snapshot it, don't re-read
 *   a live admin setting), or the settlement math mixes scales.
 */
export const usdToCreditsStochastic = (
  usd: number,
  rng: () => number = cryptoUniform,
  rate: number = CREDITS_PER_USD_COST
): number => {
  const raw = usd * rate;
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  const base = Math.floor(raw);
  const fraction = raw - base;
  return base + (rng() < fraction ? 1 : 0);
};

/**
 * Output tokens the pre-flight credit hold prices when a request's max_tokens
 * ceiling exceeds it.
 *
 * max_tokens is a *ceiling*, not a prediction: adaptive reasoning models stop at
 * end_turn well short of it, so pricing the hold at the full window (128K on the
 * flagship models) reserved several thousand credits per turn regardless of answer
 * length. The excess was always refunded at settlement, but the hold IS the
 * insufficient-funds gate, so users whose balance sat between their real cost and
 * the worst case were falsely blocked.
 *
 * 16K covers the realistic long answer with headroom - the largest replies seen in
 * practice are HTML-artifact turns at roughly 10-11K output tokens (see
 * buildThinkingParams in llm-adapters/thinkingParams.ts, whose max_tokens floor was
 * sized off the same measurement).
 *
 * UNDER-RESERVATION IS ACCEPTED, NOT PREVENTED. A turn that emits more than this
 * settles as a shortfall debit at reconciliation, which is already a supported path
 * (provider-basis settlement could always exceed a hold priced on the local
 * estimate). The two sites clamp the shortfall differently: chat's
 * computeSettlementDelta (services/llm/ChatCompletionProcess.ts) floors the debit at
 * the balance snapshot taken at its OWN admission and reports the remainder as
 * writtenOffCredits; cliCompletions.ts does an unclamped $inc on success and only
 * logs an ALERT if it lands negative. Neither is a non-negativity guarantee: the
 * chat snapshot predates any sibling turn's spend (see that function's own "best
 * effort" note), and when the shortfall still fits the stale snapshot the debit
 * applies in full - writtenOffCredits 0, and no BILLING_SHORTFALL_CLAMP log - so a
 * concurrent holder can land negative there too. Either way the resulting balance
 * fails the *next* turn's own admission gate - but that bound is per turn, not per
 * holder: turns admitted concurrently are each checked against the balance at their
 * own admission and settle against a snapshot that predates their siblings' spend,
 * so a holder running turns in parallel can be shorted once per in-flight turn, not
 * once total.
 */
export const PREFLIGHT_RESERVATION_OUTPUT_TOKENS = 16_384;

/**
 * Reservation ceiling for models that spend reasoning tokens inside their output
 * budget (see reasonsWithinOutputBudget in llm-adapters/thinkingParams.ts). Those
 * tokens bill as output on top of the visible answer, so the 16K figure above -
 * which was measured on visible artifact size alone - under-reserves them badly.
 *
 * Deliberately below ADAPTIVE_THINKING_MAX_TOKENS_FLOOR (64K), which sizes the
 * request's real ceiling and therefore has to cover the worst case: exceeding it
 * truncates a reply mid-tag, an unrecoverable failure. A hold has no such duty -
 * exceeding it settles as a shortfall debit - so it is sized for the long turn
 * (roughly 3x the largest observed visible answer, leaving the rest for the trace)
 * rather than the worst one, which is what keeps the gate off affordable requests.
 */
export const PREFLIGHT_RESERVATION_REASONING_OUTPUT_TOKENS = 32_768;

/**
 * Output-token figure to price a pre-flight credit hold at, given the max_tokens
 * this request will actually send. Never raises the caller's ceiling: a request
 * that asks for less than the cap holds only what it can possibly spend.
 *
 * Reserving only, never gating: the per-member org credit cap is still priced on
 * the unshrunk ceiling at both call sites, since that check has no settlement
 * counterpart to correct an under-estimate. That is a strictly larger figure than
 * the hold, not a true upper bound on the turn - it prices one model round trip,
 * at the uncached input rate, on the primary model - so it still under-counts a
 * multi-round tool loop, a cache-write turn, or a fallback hop onto pricier pricing.
 *
 * @param reasonsWithinOutputBudget - reasonsWithinOutputBudget(modelInfo); passed as
 *   a boolean because common cannot import llm-adapters.
 */
export const reservationOutputTokens = (requestedMaxTokens: number, reasonsWithinOutputBudget = false): number =>
  Math.min(
    requestedMaxTokens,
    reasonsWithinOutputBudget ? PREFLIGHT_RESERVATION_REASONING_OUTPUT_TOKENS : PREFLIGHT_RESERVATION_OUTPUT_TOKENS
  );

const TOKENS_PER_MILLION = 1_000_000;

/**
 * Credits per 1M tokens for a USD-per-token rate: the exact amount usdToCreditsStochastic
 * settles in expectation, unrounded (4 decimals only to drop float noise). For display and
 * comparison, not for charging.
 */
export const usdPerTokenToCreditsPer1M = (usdPerToken: number, rate: number = CREDITS_PER_USD_COST): number =>
  Math.round(usdPerToken * TOKENS_PER_MILLION * rate * 10_000) / 10_000;

export interface TextModelCreditsPer1M {
  input: number;
  output: number;
  /**
   * Rate for cache-read input tokens, by the same default multiplier getTextModelCost applies.
   * Null where settlement never sees a cache read (including a Gemini or xAI model with no published
   * cache_read rate), so cached tokens bill at `input`.
   */
  cachedInput: number | null;
}

/**
 * Backends whose adapters report cache reads apart from input (CompletionInfo.cacheReadInputTokens),
 * the only way a cache read reaches getTextModelCost at its own rate. Bedrock's non-Claude families
 * report none, so their cached tokens settle at the full input rate. Must stay in sync with the
 * adapters in @bike4mind/llm-adapters that set cacheReadInputTokens.
 */
const CACHE_READ_SETTLING_BACKENDS: ReadonlySet<string> = new Set([
  ModelBackend.Anthropic,
  ModelBackend.OpenAI,
  ModelBackend.Kimi,
  ModelBackend.DeepSeek,
  ModelBackend.Gemini,
  ModelBackend.XAI,
]);

/**
 * Of those, the backends whose adapters forward cache reads only for a model that publishes a
 * cache_read rate (publishesCacheReadRate), since the 0.1x default is Anthropic's discount, not
 * theirs. On any other model of these backends the cached tokens stay in inputTokens.
 */
const PUBLISHED_CACHE_READ_BACKENDS: ReadonlySet<string> = new Set([ModelBackend.Gemini, ModelBackend.XAI]);

/** True when every pricing tier of `model` carries an explicit cache_read rate. */
export const publishesCacheReadRate = (model: Pick<ModelInfo, 'pricing'> | undefined): boolean => {
  const tiers = Object.values(model?.pricing ?? {});
  return tiers.length > 0 && tiers.every(tier => tier?.cache_read !== undefined);
};

const settlesCacheReads = (model: ModelInfo): boolean =>
  (CACHE_READ_SETTLING_BACKENDS.has(model.backend) &&
    (!PUBLISHED_CACHE_READ_BACKENDS.has(model.backend) || publishesCacheReadRate(model))) ||
  (model.backend === ModelBackend.Bedrock && stripBedrockRegionPrefix(model.id).startsWith('anthropic.'));

/**
 * A text model's base-tier rates in credits per 1M tokens, priced exactly as getTextModelCost
 * and the credit settlement charge them. Null for non-text models and for a text model with no
 * usable price (missing or all-zero map), so "unpriced" never reads as "free"; a `freeToRun`
 * model is genuinely free and reports zeros.
 */
export function getTextModelCreditsPer1M(model: ModelInfo): TextModelCreditsPer1M | null {
  if (model.type !== 'text' || !model.pricing) return null;
  const tier = pricingTierForTokens(model, 0);
  const tierPricing = tier === null ? undefined : model.pricing[tier];
  if (!tierPricing || !Number.isFinite(tierPricing.input) || !Number.isFinite(tierPricing.output)) return null;
  if (!model.freeToRun && tierPricing.input === 0 && tierPricing.output === 0) return null;
  return {
    input: usdPerTokenToCreditsPer1M(tierPricing.input),
    output: usdPerTokenToCreditsPer1M(tierPricing.output),
    cachedInput: settlesCacheReads(model)
      ? usdPerTokenToCreditsPer1M(tierPricing.cache_read ?? tierPricing.input * CACHE_READ_MULTIPLIER)
      : null,
  };
}
