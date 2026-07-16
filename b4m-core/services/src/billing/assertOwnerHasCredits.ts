import { insufficientCreditsError } from '@bike4mind/common';

/** The minimal fields the balance gate reads off a credit holder (user or org). */
export interface CreditOwnerBalance {
  currentCredits?: number;
  name?: string;
}

/**
 * Pre-flight balance gate for the embed completion path. Throws a 422
 * `insufficient_credits` when the resolved billing owner cannot cover the run.
 *
 * Deliberately pure and settings-free: it never reads `enforceCredits`, so it
 * refuses a broke owner *regardless* of the platform-wide toggle - the property
 * the embed path needs (an anonymous end-user must never spend an org into the
 * negative, even on a stage where general credit enforcement is off). Because
 * nothing else calls it, self-host `enforceCredits=false` semantics elsewhere
 * are untouched. A null/absent owner throws: no owner means nothing can be
 * billed, so the request must not run.
 */
export function assertOwnerHasCredits(
  owner: CreditOwnerBalance | null | undefined,
  opts?: { requiredCredits?: number }
): void {
  if (!owner) {
    throw insufficientCreditsError('No billing owner resolved for this request');
  }
  const required = opts?.requiredCredits ?? 1;
  const balance = owner.currentCredits ?? 0;
  if (balance < required) {
    const who = owner.name ? `${owner.name} ` : '';
    throw insufficientCreditsError(`${who}has insufficient credits to run this request`.trimStart());
  }
}
