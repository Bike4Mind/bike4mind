import type { IUserDetails } from './types/entities/OrganizationTypes';

/**
 * The org per-member credit cap is a UTC calendar-month budget. These helpers are the single
 * definition of that period, shared by the cap pre-flight (`creditService/memberCreditCap.ts`),
 * the settlement write that lazily resets a stale row (`OrganizationRepository.updateUserDetails`),
 * and the client's member usage display.
 */

/** Start of the member-budget period containing `now`: the first instant of its UTC month. */
export function getMemberCreditPeriodStart(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** When the member-budget period containing `now` ends and every member's usage resets. */
export function getMemberCreditPeriodEnd(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

/**
 * Credits spent in the current period by the member owning `details`. A row whose `periodStart`
 * is missing (a pre-monthly lifetime counter) or from an earlier month reads as 0 - the next
 * settlement resets it.
 */
export function getPeriodUsedCredits(
  details: Pick<IUserDetails, 'usedCredits' | 'periodStart'> | null | undefined,
  now: Date = new Date()
): number {
  if (!details?.periodStart) return 0;
  return new Date(details.periodStart) < getMemberCreditPeriodStart(now) ? 0 : (details.usedCredits ?? 0);
}

/**
 * The monthly cap that applies to a member: their `userDetails[].maxCredits` override when set,
 * otherwise the org default `maxCreditsPerMember`. null means uncapped. The server cap gates
 * (`creditService/memberCreditCap.ts`) and the client usage display both resolve it here.
 */
export function resolveMemberCreditCap(
  details: Pick<IUserDetails, 'maxCredits'> | null | undefined,
  orgDefault: number | null | undefined
): number | null {
  return details?.maxCredits ?? orgDefault ?? null;
}
