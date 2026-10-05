import {
  getMemberCreditPeriodEnd,
  getPeriodUsedCredits,
  IOrganizationDocument,
  resolveMemberCreditCap,
} from '@bike4mind/common';

type BudgetOrg = Pick<IOrganizationDocument, 'userDetails' | 'maxCreditsPerMember'>;

/** One member's standing against the org's monthly per-member credit budget. */
export type MemberCreditUsage = {
  /** False when the member has no `userDetails` row, so spend is not recorded against them at all. */
  tracked: boolean;
  /** Credits spent this month (0 for an untracked member). */
  used: number;
  /** Effective monthly cap (override or org default); null when uncapped. */
  cap: number | null;
  /** True when `cap` comes from a per-member override rather than the org default. */
  isOverride: boolean;
};

/** Share of the cap at which a member is warned before the server's hard block. */
export const MEMBER_CREDIT_WARNING_RATIO = 0.8;

export const formatMemberCredits = (credits: number) => Math.round(credits).toLocaleString();

export function getMemberCreditUsage(organization: BudgetOrg, userId: string, now = new Date()): MemberCreditUsage {
  const details = organization.userDetails?.find(row => row.id === userId);
  return {
    tracked: !!details,
    used: getPeriodUsedCredits(details, now),
    cap: resolveMemberCreditCap(details, organization.maxCreditsPerMember),
    isOverride: details?.maxCredits != null,
  };
}

/** "Not tracked", "120", or "120 / 500" - the usage cell of the org Members list. */
export function formatMemberCreditUsage(usage: MemberCreditUsage): string {
  if (!usage.tracked) return 'Not tracked';
  return usage.cap == null
    ? formatMemberCredits(usage.used)
    : `${formatMemberCredits(usage.used)} / ${formatMemberCredits(usage.cap)}`;
}

/** The UTC reset date, e.g. "November 1", matching the server's block message. */
export function formatMemberCreditReset(now = new Date()): string {
  return getMemberCreditPeriodEnd(now).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' });
}

export type MemberCreditBudgetNotice = { used: number; cap: number; exhausted: boolean; resetsOn: string };

/**
 * The pre-block warning for the composer: non-null once a capped member has spent
 * `MEMBER_CREDIT_WARNING_RATIO` of their monthly cap. Advisory only - the server stays the gate
 * (a cap of 0 is exhausted from the start, so it warns immediately).
 */
export function getMemberCreditBudgetNotice(
  organization: BudgetOrg,
  userId: string,
  now = new Date()
): MemberCreditBudgetNotice | null {
  const { tracked, used, cap } = getMemberCreditUsage(organization, userId, now);
  if (!tracked || cap == null || used < cap * MEMBER_CREDIT_WARNING_RATIO) return null;
  return { used, cap, exhausted: used >= cap, resetsOn: formatMemberCreditReset(now) };
}
