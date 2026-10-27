import { LIBREONCOLOGY_PRO_PRICE_ID } from '@bike4mind/server-utils/lib/entitlements/registry';
import { ORGANIZATION_SUBSCRIPTION_PRICE_ID } from '@bike4mind/server-utils/lib/subscriptions/constants';
import { SubscriptionPlanDetail, SubscriptionPlanInterval, UserSubscriptionTier } from './types';

const isTestMode = process.env.NEXT_PUBLIC_SEED_STAGE_NAME !== 'production';

// Account-tied Stripe price for the Professional plan; sourced per-stage from
// NEXT_PUBLIC_* env vars with no brand fallback. Exported as the single
// source of truth so the upsell modal (SubscriptionModal) doesn't re-type the ids.
// Empty when unconfigured == Professional checkout inactive. PlansSection picks the stage at runtime,
// so it calls the resolver rather than reading the build-time constant.
export const professionalPriceIdForStage = (testMode: boolean): string =>
  testMode
    ? (process.env.NEXT_PUBLIC_STRIPE_PRICE_PRO_TEST ?? '')
    : (process.env.NEXT_PUBLIC_STRIPE_PRICE_PRO_PROD ?? '');

export const PROFESSIONAL_PRICE_ID = professionalPriceIdForStage(isTestMode);

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
    // [DELETION-FOOTPRINT] Launch gate: publicly purchasable only when the
    // `EnableLibreOncology` admin setting is ON (per-environment, default off).
    // Enforced generically in pages/api/subscriptions/subscribe.ts via
    // `availabilityFlag`; the upgrade page reads the same flag to show "coming
    // soon". Prevents buying into the product before its lake/courses are live.
    availabilityFlag: 'EnableLibreOncology',
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
      'Models from OpenAI, Anthropic, Google, xAI, DeepSeek and Moonshot',
      'Credits roll over for 3 months',
      'Single API for all models',
    ],
    description: 'Access every major AI model through one unified interface.',
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

/**
 * The Team (org seat) plan, as the tier and plan resolvers see it. Kept out of SUBSCRIPTION_PLANS
 * because that list drives the individual checkout, plan-change and credit-granting flows, which
 * Team billing does not go through. Seat members reach it via getActiveSubscriptionsForUser.
 */
export const TEAM_PLAN: Pick<SubscriptionPlanDetail, 'priceId' | 'name' | 'interval' | 'tier'> = {
  priceId: ORGANIZATION_SUBSCRIPTION_PRICE_ID,
  name: 'Team',
  interval: SubscriptionPlanInterval.Monthly,
  tier: UserSubscriptionTier.Pro,
};

/**
 * The individual plan checkout sells under `priceId`. The subscribe route and the invoice credit grant
 * both resolve through this, and the admin checkout catalog test asserts every listed plan does too.
 */
export const findSubscriptionPlan = (priceId: string): SubscriptionPlanDetail | undefined =>
  SUBSCRIPTION_PLANS.find(plan => plan.priceId === priceId);

/** Whether `priceId` is the Team seat price the org subscribe route accepts. */
export const isTeamPlanPriceId = (priceId: string): boolean => priceId === TEAM_PLAN.priceId;
