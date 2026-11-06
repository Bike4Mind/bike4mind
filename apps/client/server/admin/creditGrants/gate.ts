import { getApprovalPolicy, type ApprovalPolicy } from '@server/admin/approvals/service';

/** The policy when approvals are on and `credits` is over the threshold (equal still runs), else null. */
export async function creditGrantNeedsApproval(credits: number): Promise<ApprovalPolicy | null> {
  const policy = await getApprovalPolicy();
  return policy.enabled && credits > policy.creditThreshold ? policy : null;
}
