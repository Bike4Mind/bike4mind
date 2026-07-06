import { LIBREONCOLOGY_PRO_PRICE_ID } from '@client/lib/entitlements/registry';
import { SubscriptionPlanDetail, SubscriptionPlanInterval, UserSubscriptionTier } from './types';

const isTestMode = process.env.NEXT_PUBLIC_SEED_STAGE_NAME !== 'production';

// Account-tied Stripe price for the Professional plan; sourced per-stage from
// NEXT_PUBLIC_* env vars with no brand fallback. Exported as the single
// source of truth so the upsell modal (SubscriptionModal) doesn't re-type the ids.
// Empty when unconfigured == Professional checkout inactive.
export const PROFESSIONAL_PRICE_ID = isTestMode
  ? (process.env.NEXT_PUBLIC_STRIPE_PRICE_PRO_TEST ?? '')
  : (process.env.NEXT_PUBLIC_STRIPE_PRICE_PRO_PROD ?? '');

export const SUBSCRIPTION_PLANS: Array<SubscriptionPlanDetail> = [
  {
    // [DELETION-FOOTPRINT] LibreOncology - the paid individual plan the
    // upgrade page sells and that admin grant-subscription validates against.
    // priceId is the single source of truth from the entitlement registry
    // (both stages). Pricing settled: $19/mo (interval below), credits a
    // default launch allotment (below). Runtime-configurable credits are
    // tracked in the "LibreOncology admin settings" quest (ACCESS_MODEL §8).
    priceId: LIBREONCOLOGY_PRO_PRICE_ID,
    interval: SubscriptionPlanInterval.Monthly,
    name: 'LibreOncology',
    // Default launch allotment at the uniform $0.0006/credit anchor
    // ($19 / 0.0006, matching the Professional plan); will become
    // runtime-configurable via the LibreOncology admin-settings quest
    // (see ACCESS_MODEL §8 / §10).
    credits: 31667,
    // No tier: LibreOncology is a separate product, not a rung on the B4M plan
    // ladder. Omitting tier keeps it out of the cross-plan change flow
    // (change.ts rejects tier-less plans), so a B4M subscriber can't silently
    // swap into/out of it via /api/subscriptions/change against a same-tier
    // B4M plan. See SubscriptionPlanDetail.tier.
    //
    // hidden: sold via its own surface (/libreoncology/upgrade), so it must not
    // appear in the generic B4M credits/upgrade modal. Still present in
    // SUBSCRIPTION_PLANS / SUBSCRIPTION_PLANS_MAP for admin-grant + webhook
    // credit-granting.
    hidden: true,
    features: [
      'All disease-site courses, unlocked',
      'Full guided clinical pathways',
      'Uncapped grounded tutor — answers cited to the curated library',
      'Complete clinical reference tables (dose constraints, fractionation)',
    ],
    description: 'Full access to LibreOncology — every course, guided pathway, and the uncapped grounded tutor.',
  },
  {
    priceId: PROFESSIONAL_PRICE_ID,
    interval: SubscriptionPlanInterval.Monthly,
    name: 'Professional',
    // $30 / $0.0006 at the uniform per-credit anchor - same rate as the
    // one-time packages, so subscribers get exactly the advertised markup.
    credits: 50000,
    tier: UserSubscriptionTier.Basic,
    features: [
      'Access to 25+ AI models including GPT-4, Claude 3, Gemini',
      'Self-hosted Deepseek R1 & Phi-4 for private inference',
      'Automatic model cost optimization',
      'Credits roll over for 3 months',
      'Advanced prompt engineering tools',
      'Single API for all models',
      'Priority support response',
    ],
    description: 'Access every major AI model through one unified interface, with smart cost optimization.',
  },
];

/**
 * Group subscription plans by interval, for the generic B4M plan UI
 * (CreditsModal). `hidden` plans (sold via their own product surface, e.g.
 * LibreOncology) are excluded so they never render in the B4M upsell modal.
 */
export const SUBSCRIPTION_PLANS_GROUPED_BY_INTERVAL = SUBSCRIPTION_PLANS.filter(plan => !plan.hidden).reduce(
  (acc, plan) => {
    if (!acc[plan.interval]) {
      acc[plan.interval] = [];
    }
    acc[plan.interval].push(plan);
    return acc;
  },
  {} as Record<SubscriptionPlanInterval, SubscriptionPlanDetail[]>
);

export const SUBSCRIPTION_PLANS_MAP = SUBSCRIPTION_PLANS.reduce(
  (acc, plan) => {
    acc[plan.priceId] = plan;
    return acc;
  },
  {} as Record<string, SubscriptionPlanDetail>
);
