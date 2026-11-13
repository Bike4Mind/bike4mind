import { getPeriodUsedCredits, orgAlertPeriodKey, resolveMemberCreditCap, type IUserDetails } from '@bike4mind/common';
import { Organization } from '@bike4mind/database';
import { dispatchOrgAlert } from './orgAlertDispatcher';

/** Per-process memo of recent checks (ms); a capped member's refused retries would otherwise re-read and re-claim each time. */
const RECHECK_TTL_MS = 30_000;
const recentChecks = new Map<string, number>();
// Long-lived self-host processes keep this module loaded, so expired keys are swept once the map grows.
const MEMO_SWEEP_SIZE = 1000;

export function clearMemberCapAlertCache(): void {
  recentChecks.clear();
}

type MemberCapOrg = {
  personal?: boolean;
  maxCreditsPerMember?: number | null;
  serviceAccountUserId?: string | null;
  userDetails?: Array<Pick<IUserDetails, 'id' | 'usedCredits' | 'periodStart' | 'maxCredits' | 'name' | 'email'>>;
};

const fmt = (credits: number): string => Math.round(credits).toLocaleString('en-US');

/**
 * Alerts org admins once per month per member when that member reaches their monthly credit cap,
 * or when a request is `refused` by the cap pre-flight (whose estimate can trip below the cap).
 * Cap resolution mirrors creditService/memberCreditCap.ts getMemberCreditCap.
 */
export async function evaluateMemberCap(
  event: { organizationId: string; userId: string; refused?: boolean },
  now: Date = new Date()
): Promise<void> {
  const periodKey = orgAlertPeriodKey(now);
  const memoKey = `${event.organizationId}|${event.userId}|${periodKey}`;
  const nowMs = now.getTime();
  if ((recentChecks.get(memoKey) ?? 0) > nowMs) return;
  if (recentChecks.size >= MEMO_SWEEP_SIZE) {
    for (const [key, expiresAt] of recentChecks) if (expiresAt <= nowMs) recentChecks.delete(key);
  }

  const org = await Organization.findById(event.organizationId, {
    personal: 1,
    maxCreditsPerMember: 1,
    serviceAccountUserId: 1,
    userDetails: 1,
  }).lean<MemberCapOrg>();
  const row = org?.userDetails?.find(u => u.id === event.userId);
  const cap =
    org && !org.personal && org.serviceAccountUserId !== event.userId
      ? resolveMemberCreditCap(row, org.maxCreditsPerMember)
      : null;
  // Uncapped is settings-only, so it is memoized too; under-cap is not, since usage moves every debit.
  if (cap == null) {
    recentChecks.set(memoKey, nowMs + RECHECK_TTL_MS);
    return;
  }
  const used = getPeriodUsedCredits(row, now);
  if (!event.refused && used < cap) return;

  recentChecks.set(memoKey, nowMs + RECHECK_TTL_MS);
  const who = row?.name || row?.email || 'A member';
  const detail = `used ${fmt(used)} of their ${fmt(cap)} credit monthly limit, so further requests are blocked until the limit resets next month. You can raise their limit from the Members tab.`;
  await dispatchOrgAlert({
    organizationId: event.organizationId,
    kind: 'member_cap',
    scope: `user:${event.userId}`,
    subjectUserId: event.userId,
    periodKey,
    title: 'Member reached their credit limit',
    message: `${who} has ${detail}`,
    // The Inbox row belongs to the admin, so erasing the member would not reach their name in it.
    inboxMessage: `A member has ${detail}`,
  });
}
