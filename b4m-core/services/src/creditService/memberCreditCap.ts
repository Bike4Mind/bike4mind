import { IOrganizationDocument } from '@bike4mind/common';

/**
 * Per-member credit cap logic, factored out so the two reservation pre-flights
 * (web chat in ChatCompletionProcess, CLI/API in cliCompletions) share one
 * decision instead of hand-copying it.
 *
 * The cap MUST be enforced at reservation (before work begins), never at
 * settlement: by settlement the response has streamed and the balance has
 * already moved, so a throw there cannot block the request - it can only
 * sabotage the usage tracking that runs alongside it (#1536). These helpers are
 * therefore the pre-flight guard; the settlement write in
 * `deductCreditsWithOrgSupport` intentionally does NOT re-check the cap.
 */

type MemberCapOrg = Pick<IOrganizationDocument, 'userDetails' | 'maxCreditsPerMember'>;

/** Credits a member has already spent against the org pool (0 when untracked). */
export function getMemberUsedCredits(organization: Pick<IOrganizationDocument, 'userDetails'>, userId: string): number {
  return organization.userDetails?.find(u => u.id === userId)?.usedCredits ?? 0;
}

/**
 * Whether charging `credits` to `userId` would push them past the org's
 * per-member cap. Returns false when no cap is configured (`maxCreditsPerMember`
 * null/undefined). Uses the caller's estimate at reservation; a request already
 * in flight is allowed to finish and settle its actuals, so a single request may
 * nudge fractionally over the cap (mirrors the org-pool reservation, which also
 * gates on the estimate).
 */
export function isMemberCreditCapExceeded(organization: MemberCapOrg, userId: string, credits: number): boolean {
  if (organization.maxCreditsPerMember == null) {
    return false;
  }
  return getMemberUsedCredits(organization, userId) + credits > organization.maxCreditsPerMember;
}
