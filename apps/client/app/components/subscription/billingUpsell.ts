import type { UpsellSurface } from '@client/app/utils/funnelEvents';

/** GA4 `surface` ids for the Billing modal's sections; stable, they are report dimensions. */
export const BILLING_UPSELL_SURFACES = {
  plans: 'billing_plans',
  credits: 'billing_credits',
} as const satisfies Record<string, UpsellSurface>;

// The `plan` a click offers; Professional and team match the names begin_checkout reports.
export const BILLING_UPSELL_PLANS = { professional: 'Professional', team: 'team', creditPack: 'credit_pack' } as const;
