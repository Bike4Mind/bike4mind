export const isTestMode = process.env.NEXT_PUBLIC_SEED_STAGE_NAME !== 'production';

// Account-tied Stripe price; sourced per-stage from NEXT_PUBLIC_* env vars with no
// brand fallback. Empty when unconfigured == org checkout inactive.
export const ORGANIZATION_SUBSCRIPTION_PRICE_ID = isTestMode
  ? (process.env.NEXT_PUBLIC_STRIPE_PRICE_ORG_SUB_TEST ?? '')
  : (process.env.NEXT_PUBLIC_STRIPE_PRICE_ORG_SUB_PROD ?? '');

export const ORGANIZATION_SUBSCRIPTION_MIN_SEATS = 4;

/**
 * Number of credits to add per seat when a subscription quantity update is invoiced
 */
export const ORGANIZATION_SUBSCRIPTION_CREDITS_PER_SEAT = 50000;

export const ORGANIZATION_SUBSCRIPTION_MAX_SEATS = 100;
