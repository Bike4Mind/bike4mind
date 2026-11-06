import { adminAuditLogRepository } from '@bike4mind/database';
import { getApprovalPolicy, type ApprovalPolicy } from '@server/admin/approvals/service';

const HOUR_MS = 60 * 60 * 1000;

/**
 * The policy when approvals are on and `credits`, plus what this admin granted over the approval
 * expiry window, is over the threshold (equal still runs), else null. Summing the window means a
 * grant split into smaller ones is held to the same threshold as one large grant.
 */
export async function creditGrantNeedsApproval(credits: number, actorUserId: string): Promise<ApprovalPolicy | null> {
  const policy = await getApprovalPolicy();
  if (!policy.enabled || credits <= 0) return null;
  if (credits > policy.creditThreshold) return policy;
  const since = new Date(Date.now() - policy.expiryHours * HOUR_MS);
  // Grants this admin ran as the approver of someone else's request were already reviewed.
  const recent = await adminAuditLogRepository.sumCreditsGranted(actorUserId, since, { excludeApproved: true });
  return credits + recent > policy.creditThreshold ? policy : null;
}
