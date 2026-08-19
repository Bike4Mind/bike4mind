// Purchase conversion tracking: fires the GA4 `purchase` event and the Reddit
// `Purchase` conversion when a subscription checkout completes, stamped with the
// same acquisition attribution as signup (see attributionCookies.ts).
//
// This is the event that makes paid acquisition measurable. Signup alone proves
// interest; until revenue lands in the ad platforms, campaigns can only be
// optimized toward cheap clicks, never toward customers.
//
// The figures are NOT taken from the browser. The caller reads them from the
// Stripe checkout session server-side (see pages/api/subscriptions/
// checkout-session.ts) because a value that came from a URL or from client
// storage could be forged, and forged revenue in the ad platforms is worse than
// no revenue at all - it would train bidding on fiction.
//
// Consent is handled upstream: GA4 runs in consent mode and the Reddit pixel
// script is consent-deferred, so calling this is safe in any consent state.

import { attributionParams } from './attributionCookies';
import { trackRedditEvent } from './redditPixel';

declare function gtag(...args: unknown[]): void;

export interface PurchaseConversion {
  /** Dedupe key. GA4 drops a repeat `purchase` with a seen transaction_id. */
  transactionId: string;
  /** Charge total in the currency's MAJOR unit (29.99, not 2999). */
  value: number;
  /** ISO 4217, e.g. "USD". */
  currency: string;
  /** The Stripe price the customer bought - GA4's `item_id`. */
  priceId?: string;
  /** Human-readable plan name, when known - GA4's `item_name`. */
  planName?: string;
  /** Seats/units purchased. Defaults to 1. */
  quantity?: number;
}

/**
 * Fire the purchase conversion across all wired channels in one place.
 *
 * Callers own once-per-purchase semantics; `transactionId` is the backstop
 * (GA4 dedupes on it, and it is passed to Reddit for the same reason).
 */
export function trackPurchaseConversion(purchase: PurchaseConversion): void {
  if (typeof window === 'undefined') return;

  const { transactionId, value, currency, priceId, planName, quantity = 1 } = purchase;

  if (typeof gtag !== 'undefined') {
    const params: Record<string, unknown> = {
      transaction_id: transactionId,
      value,
      currency,
      ...attributionParams('purchase'),
    };
    // GA4 renders monetization reports off `items`; a purchase with no item is
    // counted but shows no product, which makes plan-level revenue invisible.
    if (priceId || planName) {
      params.items = [
        {
          item_id: priceId,
          item_name: planName,
          price: value / quantity,
          quantity,
        },
      ];
    }
    gtag('event', 'purchase', params);
  }

  trackRedditEvent('Purchase', { value, currency, transactionId });
}
