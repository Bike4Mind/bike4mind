import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { api } from '@client/app/contexts/ApiContext';
import { trackPurchaseConversion } from '@client/app/utils/purchaseConversion';

/**
 * Handles Stripe Checkout success redirects globally (subscription checkout success).
 *
 * Also the one place a completed purchase is reported to analytics. Renewals bill
 * through Stripe without a redirect, so only genuinely new subscriptions reach
 * here - which is exactly the "first charge" the acquisition funnel needs.
 */

/** Reported checkout sessions, so a reload or a re-mount cannot double-count. */
const REPORTED_SESSIONS_KEY = 'b4m-reported-checkout-sessions';

/**
 * Claim a session id for reporting; false when it was already claimed.
 *
 * sessionStorage rather than a module-level Set: the redirect back from Stripe is
 * a full page load, and a customer who reloads the success URL before the query
 * string is cleaned would otherwise report a second purchase. Synchronous
 * check-and-set, so React's double-invoked effects in development cannot race it.
 * Best-effort by design - if storage is unavailable, GA4 still dedupes on
 * transaction_id.
 */
function claimSessionForReporting(sessionId: string): boolean {
  try {
    const raw = window.sessionStorage.getItem(REPORTED_SESSIONS_KEY);
    const reported: string[] = raw ? JSON.parse(raw) : [];
    if (reported.includes(sessionId)) return false;
    window.sessionStorage.setItem(REPORTED_SESSIONS_KEY, JSON.stringify([...reported, sessionId]));
    return true;
  } catch {
    return true;
  }
}

const StripeCheckoutSuccessHandler = () => {
  const queryClient = useQueryClient();

  useEffect(() => {
    // Use URLSearchParams instead of useSearch to avoid router context dependency
    const searchParams = new URLSearchParams(window.location.search);
    const subscriptionSuccess = searchParams.get('subscription_success');
    const checkoutSessionId = searchParams.get('checkout_session_id');

    if (subscriptionSuccess === 'true') {
      queryClient.invalidateQueries({ queryKey: ['organizations'] });
      queryClient.invalidateQueries({ queryKey: ['subscriptions'] });

      toast.success('Subscription completed successfully!');

      // Report revenue before the URL is rewritten. The amount is read server-side
      // from Stripe rather than passed through the browser, so it cannot be forged
      // - see api/subscriptions/checkout-session.ts. Admin-initiated conversions
      // redirect without a session id and are intentionally not reported: they are
      // not customer-attributable acquisitions.
      if (checkoutSessionId && checkoutSessionId.startsWith('cs_') && claimSessionForReporting(checkoutSessionId)) {
        // Deliberately not awaited and never surfaced: analytics must not delay or
        // interrupt the customer's first authenticated moment after paying.
        api
          .get('/api/subscriptions/checkout-session', { params: { id: checkoutSessionId } })
          .then(response => trackPurchaseConversion(response.data))
          .catch(() => {});
      }

      // Clean up URL without triggering a refresh. Strip only OUR two params and
      // keep everything else: rewriting to the bare pathname would discard the
      // caller's own query and hash, which now matters because the individual
      // checkout path reaches this code for the first time (its callbackUrl can
      // carry a redirectTo and the router preserves hashes).
      searchParams.delete('subscription_success');
      searchParams.delete('checkout_session_id');
      const remaining = searchParams.toString();
      const newUrl = `${window.location.pathname}${remaining ? `?${remaining}` : ''}${window.location.hash}`;
      window.history.replaceState({}, '', newUrl);
    }
  }, [queryClient]);

  return null;
};

export default StripeCheckoutSuccessHandler;
