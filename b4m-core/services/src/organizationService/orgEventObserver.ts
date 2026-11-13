/**
 * Org event observer (host seam) for admin alerts.
 *
 * A leaf with no imports, like llm/toolFinishObserver.ts: callers reach it via
 * '@bike4mind/services/organizationService/orgEventObserver', never the barrel, and the host
 * registers its dispatcher from apps/client's baseApi and the queue handler wrapper
 * (packages/server-utils/src/organizations/orgAlertDispatcher.ts).
 */

export type OrgEvent =
  | { type: 'credit_debit'; organizationId: string; balanceAfter: number; actingUserId?: string }
  | { type: 'seat_limit'; organizationId: string; seats: number }
  /** `actorUserId` is the admin who added them, if any; neither is notified. */
  | { type: 'member_joined'; organizationId: string; userId: string; actorUserId?: string }
  /** Raised only after the owner's own payment-failed email went out, so the owner gets no second email. */
  | { type: 'payment_failed'; organizationId: string; invoiceId: string }
  /** After a member's usage is recorded, or when the cap pre-flight refuses their request (`refused`). */
  | { type: 'member_cap_check'; organizationId: string; userId: string; refused?: boolean };

type OrgEventObserver = (event: OrgEvent) => Promise<void> | void;

let orgEventObserver: OrgEventObserver | null = null;

/** Registers the single host observer. Pass null to clear. */
export function setOrgEventObserver(observer: OrgEventObserver | null): void {
  orgEventObserver = observer;
}

/** Awaits the observer and swallows its failures, so an alert can never fail the caller's operation. */
export async function notifyOrgEvent(event: OrgEvent): Promise<void> {
  if (!orgEventObserver) return;
  try {
    await orgEventObserver(event);
  } catch {
    // alerts are best effort
  }
}
