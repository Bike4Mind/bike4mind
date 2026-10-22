import { z } from 'zod';

export const subscriptionPlanSchema = z.object({
  priceId: z.string(),
  // Must be a real URL - origin is further restricted to the deployed app in
  // the subscribe handler (isAllowedCallbackOrigin) to prevent an open-redirect
  // through Stripe's hosted checkout success/cancel pages.
  callbackUrl: z.string().url(),
});

/**
 * Which UI started a checkout (an upsell surface id, see app/utils/funnelEvents.ts). Recorded on the
 * Stripe session as `checkout_surface` so a purchase can be traced to the prompt that drove it.
 */
export const checkoutSurfaceSchema = z.string().regex(/^[a-z0-9_]{1,40}$/);

export const subscriptionCheckoutSchema = subscriptionPlanSchema.extend({
  // Older callers can still buy, but may not attach attribution without consent.
  attributionConsent: z.boolean().optional(),
  surface: checkoutSurfaceSchema.optional(),
});
