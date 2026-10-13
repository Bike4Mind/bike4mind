import { useEffect } from 'react';
import { api } from '@client/app/contexts/ApiContext';
import { trackPurchaseConversion } from '@client/app/utils/purchaseConversion';
import { claimSessionForReporting, releaseSessionClaim } from './StripeCheckoutSuccessHandler';

/**
 * Reports a completed credit purchase to analytics when Stripe returns the customer.
 *
 * Credit packs are paid with the Payment Element (Credits/CheckoutForm.tsx), which
 * confirms with `redirect: 'if_required'`. Card payments settle in-page and the form
 * reports them through reportCreditPurchaseConversion; redirect-only methods return to
 * its return_url - the page the customer bought from - with `payment_intent`,
 * `payment_intent_client_secret` and `redirect_status` appended, handled here. StripeCheckoutSuccessHandler covers subscription Checkout; this is the
 * credit-purchase counterpart, so a pack bought from an ad-driven visit is a
 * conversion like a subscription is.
 *
 * The URL only says which payment to look up. Whether it succeeded, how much moved and
 * whose it is are read from Stripe server-side (api/stripe/payment-intent.ts), so the
 * reported value cannot be forged from the address bar.
 */

export const PAYMENT_RETURN_PARAMS = ['payment_intent', 'payment_intent_client_secret', 'redirect_status'] as const;

/**
 * Reports one succeeded credit purchase, at most once per intent per tab session. Shared by
 * the redirect return below and the in-page confirm in Credits/CheckoutForm.tsx, so a
 * payment reaches the ad platforms whichever way it settled.
 */
export function reportCreditPurchaseConversion(paymentIntentId: string): void {
  if (!paymentIntentId.startsWith('pi_') || !claimSessionForReporting(paymentIntentId)) return;
  // Not awaited and never surfaced, as for subscriptions: analytics must not
  // delay or interrupt the customer. A failed lookup releases the claim so a retry can report.
  api
    .get('/api/stripe/payment-intent', { params: { id: paymentIntentId } })
    .then(response => trackPurchaseConversion(response.data))
    .catch(() => releaseSessionClaim(paymentIntentId));
}

const StripePaymentReturnHandler = () => {
  useEffect(() => {
    const searchParams = new URLSearchParams(window.location.search);
    const paymentIntentId = searchParams.get('payment_intent');
    if (!paymentIntentId) return;

    // `processing` (bank debits) settles later and `failed` moved no money; only a
    // succeeded return is worth a lookup. The server checks again regardless.
    if (searchParams.get('redirect_status') === 'succeeded') {
      reportCreditPurchaseConversion(paymentIntentId);
    }

    // Strip Stripe's params, keeping the rest of the URL. The client secret in
    // particular should not linger in the address bar or history.
    for (const name of PAYMENT_RETURN_PARAMS) searchParams.delete(name);
    const remaining = searchParams.toString();
    window.history.replaceState(
      {},
      '',
      `${window.location.pathname}${remaining ? `?${remaining}` : ''}${window.location.hash}`
    );
  }, []);

  return null;
};

export default StripePaymentReturnHandler;
