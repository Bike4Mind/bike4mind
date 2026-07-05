import { z } from 'zod';

export const subscriptionPlanSchema = z.object({
  priceId: z.string(),
  // Must be a real URL - origin is further restricted to the deployed app in
  // the subscribe handler (isAllowedCallbackOrigin) to prevent an open-redirect
  // through Stripe's hosted checkout success/cancel pages.
  callbackUrl: z.string().url(),
});
