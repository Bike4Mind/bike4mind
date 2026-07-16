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
 */
const CREDITS_PER_USD_COST = (() => {
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
 */
export const usdToCredits = (usd: number): number => {
  return Math.max(1, Math.ceil(usd * CREDITS_PER_USD_COST));
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
 */
export const usdToCreditsStochastic = (usd: number, rng: () => number = cryptoUniform): number => {
  const raw = usd * CREDITS_PER_USD_COST;
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  const base = Math.floor(raw);
  const fraction = raw - base;
  return base + (rng() < fraction ? 1 : 0);
};
