/**
 * Checkout started from another Bike4Mind app, which sends the buyer back to that app afterwards.
 *
 * `/subscriptions/checkout?plan=<plan>&return_to=<url>`: `plan` is a Stripe price id, or a name in
 * CHECKOUT_PLAN_ALIASES (routes/subscriptions/checkout.tsx) so an app outside this repo never has to
 * carry one. `return_to` is honoured only for an origin in CHECKOUT_RETURN_ORIGINS. Stripe still returns to this app's own origin (the
 * subscribe route allows no other), carrying the target as CHECKOUT_RETURN_PARAM, and
 * StripeCheckoutSuccessHandler forwards there once the purchase is confirmed and reported, or at
 * once on a cancel. Nothing here touches the server: the open-redirect guard on Stripe's callback
 * URLs (server/integrations/stripe/callbackUrl.ts) is unchanged.
 */

/** Apps a checkout may return to. Exact origins, https only. */
export const CHECKOUT_RETURN_ORIGINS: readonly string[] = ['https://paintbox.bike4mind.com'];

/** The query parameter the return target rides on through Stripe and back. */
export const CHECKOUT_RETURN_PARAM = 'checkout_return_to';

/** Returns `value` as an absolute URL when its origin may be returned to, else null. */
export function allowedCheckoutReturn(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  return CHECKOUT_RETURN_ORIGINS.includes(url.origin) ? url.href : null;
}

/** The Stripe callback for a checkout on `origin`: this app, carrying the allowed return target if any. */
export function checkoutCallbackUrl(origin: string, returnTo: string | null): string {
  if (!returnTo) return origin;
  return `${origin}/?${new URLSearchParams({ [CHECKOUT_RETURN_PARAM]: returnTo }).toString()}`;
}
