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
  | { type: 'member_joined'; organizationId: string; userId: string }
  | { type: 'payment_failed'; organizationId: string; invoiceId: string };

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
