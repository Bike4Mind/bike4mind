/**
 * One-shot, in-memory note that this page load is a Stripe return to an open Billing modal. The
 * remounted modal consumes it so the redirect is not logged as a second open and an abandonment.
 * Memory only: a reload must not suppress a genuine later open.
 */
let returned = false;

export function markBillingCheckoutReturn(): void {
  returned = true;
}

export function consumeBillingCheckoutReturn(): boolean {
  const value = returned;
  returned = false;
  return value;
}
