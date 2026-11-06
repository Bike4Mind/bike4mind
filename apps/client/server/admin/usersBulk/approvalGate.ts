import { ForbiddenError, type AdminPermissionId } from '@bike4mind/common';
import type { Request } from 'express';
import type { AdminUsersBulkAction, AdminUsersBulkExecuteRequest } from '@client/app/utils/adminUsersBulk';
import { getApprovalPolicy, requestApproval, type ApprovalPendingBody } from '@server/admin/approvals/service';
import { selfIdsOf } from './actor';
import { usersBulkResolveDeps } from './adapters';
import { confirmedCohort } from './execute';
import { netCreditsAdded, type ResolveDeps } from './resolve';

const GATED_TYPES: ReadonlySet<AdminUsersBulkAction['type']> = new Set(['suspend', 'contain', 'adjustCredits']);

export const usersBulkApprovalPermission = (action: AdminUsersBulkAction): AdminPermissionId =>
  action.type === 'adjustCredits' ? 'credits:adjust' : 'users:moderate';

/**
 * Stores the execute for a second admin when approvals are on and it acts on more users (or adds
 * more credits) than the thresholds allow; null means it runs now. The cohort is checked first with
 * the same 400/409 refusals execute uses, and stored as its sorted ids so a filter cannot drift.
 */
export async function requestUsersBulkApprovalIfNeeded(
  req: Request,
  request: AdminUsersBulkExecuteRequest,
  deps: ResolveDeps = usersBulkResolveDeps
): Promise<ApprovalPendingBody | null> {
  if (!GATED_TYPES.has(request.action.type)) return null;
  const policy = await getApprovalPolicy();
  if (!policy.enabled) return null;
  if (!req.user) throw new ForbiddenError('Unauthorized. Admin access required.');

  const users = await confirmedCohort(request, { id: req.user.id, selfIds: selfIdsOf(req.user) }, deps, new Date());
  const overUsers = users.length > policy.bulkUserThreshold;
  const overCredits =
    request.action.type === 'adjustCredits' && netCreditsAdded(request.action, users) > policy.creditThreshold;
  if (!overUsers && !overCredits) return null;

  const userIds = users.map(user => user.id).sort();
  return requestApproval(
    req,
    {
      action: 'users.bulk',
      params: { ...request, target: { kind: 'ids', userIds } },
      summary: `Bulk ${request.action.type} of ${userIds.length} users`,
      reason: request.reason,
      requiredPermission: usersBulkApprovalPermission(request.action),
    },
    policy
  );
}
