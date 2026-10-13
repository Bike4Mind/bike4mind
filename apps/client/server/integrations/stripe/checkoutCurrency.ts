import type Stripe from 'stripe';

/**
 * Spread into every `checkout.sessions.create` call: the company bills in US dollars only.
 * `currency` pins which of a price's currency_options is charged, and disabling Adaptive
 * Pricing stops Checkout from presenting (and charging) a local currency converted from
 * the visitor's location, which the account-level dashboard setting would otherwise allow.
 * Kept out of stripe.ts so handler tests that mock the Stripe client still exercise it.
 */
export const USD_CHECKOUT_SESSION_PARAMS = {
  currency: 'usd',
  adaptive_pricing: { enabled: false },
} as const satisfies Pick<Stripe.Checkout.SessionCreateParams, 'currency' | 'adaptive_pricing'>;
