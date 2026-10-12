// Client half of the funnel instrumentation: checkout starts and upsell exposure, on the same GA4
// gtag and ad-pixel helpers the signup/purchase conversions use (signupConversion.ts,
// purchaseConversion.ts). Server stages (credits_granted, email_verified, first_value) live in
// server/analytics/funnel.ts. Consent is handled upstream exactly as for those conversions: GA4
// runs in consent mode, the pixels are consent-deferred, and attributionParams is consent-gated.

import { checkoutSurfaceSchema } from '@client/lib/userSubscriptions/schemas';
import { attributionParams } from './attributionCookies';
import { trackMetaEvent } from './metaPixel';

declare function gtag(...args: unknown[]): void;

/**
 * Where a monetization prompt lives. Free-form so a UI owner can add one without touching this
 * file, but keep it snake_case and stable: it becomes a GA4 dimension and the Stripe session's
 * `checkout_surface` (checkoutSurfaceSchema caps it at 40 chars of [a-z0-9_]).
 */
export type UpsellSurface = string;

export type UpsellAction = 'impression' | 'click' | 'dismiss';

export interface UpsellParams {
  surface: UpsellSurface;
  /** What raised the prompt, e.g. `insufficient_credits`, `low_balance`, `limit_hit`. */
  trigger?: string;
  /** The plan the prompt offers, if any. */
  plan?: string;
}

// Set from the signed-in user (UserContext). Synthetic test personas never reach funnel metrics.
let syntheticUser = false;

export function setFunnelSyntheticUser(isSynthetic: boolean): void {
  syntheticUser = isSynthetic;
}

/** The surface if checkout will accept it, else undefined - a malformed id must not fail a purchase. */
export function checkoutSurfaceParam(surface: UpsellSurface | undefined): UpsellSurface | undefined {
  return surface !== undefined && checkoutSurfaceSchema.safeParse(surface).success ? surface : undefined;
}

const seenImpressions = new Set<string>();

/** Test-only: forget which impressions this page load has already reported. */
export function resetUpsellImpressionsForTest(): void {
  seenImpressions.clear();
}

function sendGtag(event: string, params: Record<string, unknown>): boolean {
  if (typeof window === 'undefined' || syntheticUser || typeof gtag === 'undefined') return false;
  gtag('event', event, params);
  return true;
}

/**
 * Report an upsell prompt being shown, clicked or dismissed. Impressions are deduplicated per
 * surface per page load, so calling this from a render or mount effect is safe. Returns whether an
 * event was sent.
 */
export function trackUpsell(action: UpsellAction, params: UpsellParams): boolean {
  if (action === 'impression') {
    if (seenImpressions.has(params.surface)) return false;
    seenImpressions.add(params.surface);
  }
  return sendGtag(`upsell_${action}`, {
    surface: params.surface,
    ...(params.trigger && { trigger: params.trigger }),
    ...(params.plan && { plan: params.plan }),
  });
}

export interface BeginCheckoutParams {
  /** Plan name (e.g. `Professional`, `team`). */
  plan: string;
  priceId: string;
  ownerType: 'user' | 'organization';
  /** Which UI started the checkout; `unknown` when the caller did not say. */
  surface?: UpsellSurface;
  /** Seats, for a team checkout. */
  quantity?: number;
}

/** GA4 `begin_checkout` plus Meta `InitiateCheckout`, fired as the Stripe session is requested. */
export function trackBeginCheckout(params: BeginCheckoutParams): boolean {
  if (typeof window === 'undefined' || syntheticUser) return false;
  trackMetaEvent('InitiateCheckout');
  return sendGtag('begin_checkout', {
    plan: params.plan,
    owner_type: params.ownerType,
    surface: params.surface ?? 'unknown',
    items: [{ item_id: params.priceId, item_name: params.plan, quantity: params.quantity ?? 1 }],
    ...attributionParams('checkout'),
  });
}
