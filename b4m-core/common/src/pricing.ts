const DEFAULT_PRICE_MARGIN = 3;
const DEFAULT_USD_TO_CREDITS_RATE = 0.0006;

/**
 * Accepts an env override only if it is a strictly parsed positive finite
 * number. Number() (not parseFloat) so a truncated value like "2,5" is
 * rejected rather than silently billed as 2. Zero or negative would mean
 * free or negative billing. Warns on rejected values so a discarded
 * override is distinguishable from an applied one; unset stays silent.
 */
const envNumber = (name: string, raw: string | undefined, fallback: number): number => {
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  console.warn(`[pricing] Ignoring invalid ${name}="${raw}"; using default ${fallback}`);
  return fallback;
};

// Literal process.env.NEXT_PUBLIC_* member access is required for Next.js to
// inline the values into the client bundle (same pattern as constants/dataLakes.ts),
// keeping displayed prices and server billing on the same value when the var is
// set in the shared deploy config for both build and runtime. The typeof guard
// keeps non-Next browser bundles (no process global) importable.
const hasProcess = typeof process !== 'undefined';

/**
 * Target markup multiple over provider COGS (3 = charge 3x what the provider bills us).
 * Covers payment fees, infrastructure, and provider price wobble.
 */
const PRICE_MARGIN = envNumber(
  'NEXT_PUBLIC_PRICE_MARGIN',
  hasProcess ? process.env.NEXT_PUBLIC_PRICE_MARGIN : undefined,
  DEFAULT_PRICE_MARGIN
);

/**
 * What a credit actually sells for, anchored to the cheapest purchase route
 * (Professional subscription: $30 / 50,000 credits = $0.0006). Every route
 * then yields at least PRICE_MARGIN over COGS; pricier packs yield more.
 * Must be re-anchored (in code or via env) if packs or subscriptions are repriced.
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
 * The derived value is guarded: env values that individually pass validation
 * can still round to 0 here (margin/rate < 0.5), which would collapse every
 * charge to the 1-credit minimum.
 */
const CREDITS_PER_USD_COST = (() => {
  const derived = Math.round(PRICE_MARGIN / USD_TO_CREDITS_RATE);
  if (Number.isFinite(derived) && derived >= 1) return derived;
  console.warn(`[pricing] Env-configured margin/rate derive ${derived} credits per USD cost; using defaults`);
  return Math.round(DEFAULT_PRICE_MARGIN / DEFAULT_USD_TO_CREDITS_RATE);
})();

/**
 * Converts a USD cost to credits, including markup
 * @param usd - The raw provider cost in USD to convert
 * @returns The number of credits with markup, rounded up to the nearest whole number (minimum 1)
 *
 * Examples:
 * $1 USD = 5000 credits (3x markup at $0.0006/credit)
 * $0.001 USD = 5 credits
 * $0.0001 USD = 1 credit (minimum)
 */
export const usdToCredits = (usd: number): number => {
  return Math.max(1, Math.ceil(usd * CREDITS_PER_USD_COST));
};
