import type { TeamPlanSettings } from '@bike4mind/common';
import { CREDIT_PACKAGES } from '@client/lib/credits/constants';
import type { CreditPackageId } from '@client/lib/credits/types';
import { SUBSCRIPTION_PLANS, TEAM_PLAN } from '@client/lib/userSubscriptions/constants';
import type { SubscriptionPlanInterval } from '@bike4mind/server-utils/lib/userSubscriptions/types';

/**
 * What checkout sells, read from the constants the checkout paths charge and grant from:
 * CREDIT_PACKAGES (handlePackageTransaction), SUBSCRIPTION_PLANS (findSubscriptionPlan, used by the
 * subscribe route and the invoice credit grant) and TEAM_PLAN (isTeamPlanPriceId, used by the org
 * subscribe route). checkoutCatalog.test.ts resolves every listed row through those same functions.
 *
 * Price ids are env-derived, so in the admin browser they reflect this client build; a server Lambda
 * missing the same NEXT_PUBLIC_STRIPE_PRICE_* var can still disagree.
 */

export type CatalogPack = {
  id: CreditPackageId;
  priceUsd: number;
  credits: number;
  description: string;
};

export type CatalogPlanGrant =
  | { kind: 'credits'; credits: number }
  | { kind: 'perSeat'; creditsPerSeat: number; minSeats: number; maxSeats: number }
  | { kind: 'unavailable' };

export type CatalogPlan = {
  name: string;
  /** Empty when the stage's NEXT_PUBLIC_STRIPE_PRICE_* env var is unset, which disables that checkout. */
  priceId: string;
  interval: SubscriptionPlanInterval;
  grant: CatalogPlanGrant;
  availability?: string;
};

export const listCatalogPacks = (): CatalogPack[] =>
  Object.values(CREDIT_PACKAGES).map(({ id, price, credits, description }) => ({
    id,
    priceUsd: price,
    credits,
    description,
  }));

const describeAvailability = (plan: (typeof SUBSCRIPTION_PLANS)[number]): string | undefined => {
  const notes = [
    plan.hidden ? 'Sold on its own page' : undefined,
    plan.availabilityFlag ? `Needs ${plan.availabilityFlag}` : undefined,
  ].filter(Boolean);
  return notes.length > 0 ? notes.join('; ') : undefined;
};

/**
 * Team credits and seats are admin settings, so the caller passes them in already resolved, or
 * undefined when the settings could not be read (never the defaults, which may not be what is stored).
 */
export const listCatalogPlans = (team: TeamPlanSettings | undefined): CatalogPlan[] => [
  ...SUBSCRIPTION_PLANS.map(plan => ({
    name: plan.name,
    priceId: plan.priceId,
    interval: plan.interval,
    grant: { kind: 'credits' as const, credits: plan.credits },
    availability: describeAvailability(plan),
  })),
  {
    name: TEAM_PLAN.name,
    priceId: TEAM_PLAN.priceId,
    interval: TEAM_PLAN.interval,
    grant: team ? { kind: 'perSeat', ...team } : { kind: 'unavailable' },
    availability: 'Needs enableTeamPlan',
  },
];
