/**
 * Target markup multiple over provider COGS (3 = charge 3x what the provider bills us).
 * Covers payment fees, infrastructure, and provider price wobble.
 */
const PRICE_MARGIN = 3;

/**
 * What a credit actually sells for, anchored to the cheapest purchase route
 * (Professional subscription: $30 / 50,000 credits = $0.0006). Every route
 * then yields at least PRICE_MARGIN over COGS; pricier packs yield more.
 * Must be re-anchored if packs or subscriptions are repriced.
 */
const USD_TO_CREDITS_RATE = 0.0006;

/**
 * Integer credits charged per $1 of provider cost. Derived once with rounding
 * because the raw division carries float noise (0.0006 is inexact in binary):
 * naive ceil((usd * 3) / 0.0006) charges a phantom credit on exact multiples.
 */
const CREDITS_PER_USD_COST = Math.round(PRICE_MARGIN / USD_TO_CREDITS_RATE);

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
