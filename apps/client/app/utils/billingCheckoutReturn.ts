/**
 * One-shot, in-memory note that this page load is a Stripe return to an open Billing modal. The
 * remounted modal consumes it so the redirect is not logged as a second open and an abandonment.
 * Memory only: a reload must not suppress a genuine later open.
 */
// Covers the return handler -> modal mount gap; past it, a modal that never mounted must not
// swallow a later genuine open.
export const BILLING_CHECKOUT_RETURN_TTL_MS = 60_000;

let markedAt: number | null = null;

export function markBillingCheckoutReturn(now = Date.now()): void {
  markedAt = now;
}

export function consumeBillingCheckoutReturn(now = Date.now()): boolean {
  const fresh = markedAt !== null && now - markedAt < BILLING_CHECKOUT_RETURN_TTL_MS;
  markedAt = null;
  return fresh;
}
