import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { api } from '@client/app/contexts/ApiContext';
import { type PurchaseConversion, trackPurchaseConversion } from '@client/app/utils/purchaseConversion';
import { bootstrapSession } from '@client/app/utils/sessionBootstrap';
import { useAccessToken } from '@client/app/hooks/useAccessToken';
import { formatCreditAmount } from '@client/app/utils/formatCredits';
import { BILLING_SEARCH_PARAM } from '@client/app/utils/billingDeepLink';
import { markBillingCheckoutReturn } from '@client/app/utils/billingCheckoutReturn';
import { CHECKOUT_RETURN_PARAM, allowedCheckoutReturn } from '@client/app/utils/checkoutReturn';

/**
 * Handles Stripe Checkout success redirects globally (subscription checkout success).
 *
 * Also where a completed subscription is reported to analytics; credit purchases
 * are reported by StripePaymentReturnHandler. Renewals bill through Stripe without
 * a redirect, so only genuinely new subscriptions reach here - which is exactly the
 * "first charge" the acquisition funnel needs.
 */

/** Reported checkout sessions, so a reload or a re-mount cannot double-count. */
const REPORTED_SESSIONS_KEY = 'b4m-reported-checkout-sessions';

/**
 * Claim a session id for reporting; false when it was already claimed. Also claims
 * credit-purchase payment intent ids (StripePaymentReturnHandler); the prefixes keep
 * the two apart.
 *
 * sessionStorage rather than a module-level Set: the redirect back from Stripe is
 * a full page load, and a customer who reloads the success URL before the query
 * string is cleaned would otherwise report a second purchase. Synchronous
 * check-and-set, so React's double-invoked effects in development cannot race it.
 * Best-effort by design - if storage is unavailable, GA4 still dedupes on
 * transaction_id.
 */
export function claimSessionForReporting(sessionId: string): boolean {
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

/** Give a claim back after a failed lookup so a reload can report it; no-op if storage is unavailable. */
export function releaseSessionClaim(sessionId: string): void {
  try {
    const raw = window.sessionStorage.getItem(REPORTED_SESSIONS_KEY);
    const reported: string[] = raw ? JSON.parse(raw) : [];
    window.sessionStorage.setItem(REPORTED_SESSIONS_KEY, JSON.stringify(reported.filter(id => id !== sessionId)));
  } catch {
    // Best-effort, like the claim.
  }
}

const GENERIC_CONFIRMATION = 'Subscription completed successfully!';

export type CheckoutSessionSummary = PurchaseConversion & { credits?: number };

export function checkoutConfirmation({
  planName,
  credits,
}: Pick<CheckoutSessionSummary, 'planName' | 'credits'>): string {
  if (!planName) return GENERIC_CONFIRMATION;
  const onPlan = `You're on ${planName}`;
  // The plan's allotment, not a ledger read: the grant lands via webhook and can be skipped.
  return credits ? `${onPlan} - ${formatCreditAmount(credits)} credits included` : onPlan;
}

/**
 * Confirms the purchase at once, then upgrades the toast in place with the plan Stripe vouches for.
 * The return from Stripe is a full page load and the access token is memory-only, so the lookup
 * waits for the cold-load refresh; sent earlier it carries no credential and 401s. The amount is
 * read server-side (api/subscriptions/checkout-session.ts) so the reported conversion cannot be
 * forged. A failed lookup releases the claim so a reload can report it.
 */
async function confirmCheckout(sessionId: string): Promise<void> {
  toast.success(GENERIC_CONFIRMATION, { id: sessionId });
  const claimed = claimSessionForReporting(sessionId);

  await bootstrapSession();
  if (!useAccessToken.getState().accessToken) {
    if (claimed) releaseSessionClaim(sessionId);
    return;
  }

  let summary: CheckoutSessionSummary;
  try {
    const response = await api.get<CheckoutSessionSummary>('/api/subscriptions/checkout-session', {
      params: { id: sessionId },
    });
    summary = response.data;
  } catch {
    if (claimed) releaseSessionClaim(sessionId);
    return;
  }

  toast.success(checkoutConfirmation(summary), { id: sessionId });
  if (claimed) trackPurchaseConversion(summary);
}

/** How long the confirmation stays on screen before a checkout started elsewhere returns there. */
export const CHECKOUT_RETURN_DELAY_MS = 1500;

/** Sends the buyer back to the app that started the checkout. Exported for its test. */
export const checkoutReturnNavigator = { assign: (url: string) => window.location.assign(url) };

const StripeCheckoutSuccessHandler = () => {
  const queryClient = useQueryClient();

  useEffect(() => {
    // Use URLSearchParams instead of useSearch to avoid router context dependency
    const searchParams = new URLSearchParams(window.location.search);
    const subscriptionSuccess = searchParams.get('subscription_success');
    const checkoutSessionId = searchParams.get('checkout_session_id');
    // A checkout another Bike4Mind app started (utils/checkoutReturn.ts): re-checked here, because
    // this URL is one anyone can type.
    const returnTo = allowedCheckoutReturn(searchParams.get(CHECKOUT_RETURN_PARAM));

    if (subscriptionSuccess !== 'true' && returnTo) {
      // Stripe's cancel_url carries no success marker: nothing was bought, so go straight back.
      checkoutReturnNavigator.assign(returnTo);
      return;
    }

    if (subscriptionSuccess === 'true') {
      queryClient.invalidateQueries({ queryKey: ['organizations'] });
      queryClient.invalidateQueries({ queryKey: ['subscriptions'] });

      // Admin-initiated conversions redirect without a session id: nothing to look up, and not
      // reported, since they are not customer-attributable acquisitions.
      const confirmed =
        checkoutSessionId && checkoutSessionId.startsWith('cs_')
          ? confirmCheckout(checkoutSessionId)
          : Promise.resolve(void toast.success(GENERIC_CONFIRMATION));

      // Only once the purchase is confirmed and reported, so leaving cannot cost the conversion.
      if (returnTo) {
        void confirmed
          .catch(() => undefined)
          .then(() => setTimeout(() => checkoutReturnNavigator.assign(returnTo), CHECKOUT_RETURN_DELAY_MS));
      }

      // Clean up URL without triggering a refresh. Strip only OUR two params and
      // keep everything else: rewriting to the bare pathname would discard the
      // caller's own query and hash, which now matters because the individual
      // checkout path reaches this code for the first time (its callbackUrl can
      // carry a redirectTo and the router preserves hashes).
      if (searchParams.has(BILLING_SEARCH_PARAM)) markBillingCheckoutReturn();
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
