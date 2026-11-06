import { ForbiddenError, type AdminPermissionId } from '@bike4mind/common';
import { adminAuditLogRepository } from '@bike4mind/database';
import type { Request } from 'express';
import type { AdminUsersBulkAction, AdminUsersBulkExecuteRequest } from '@client/app/utils/adminUsersBulk';
import { getApprovalPolicy, requestApproval, type ApprovalPendingBody } from '@server/admin/approvals/service';
import {
  creditGrantNeedsApproval,
  reserveWithinWindow,
  RUN_NOW,
  type ReleaseWindow,
} from '@server/admin/creditGrants/gate';
import { selfIdsOf } from './actor';
import { usersBulkResolveDeps } from './adapters';
import { AUDIT_ACTION, confirmedCohort } from './execute';
import { netCreditsAdded, type ResolveDeps } from './resolve';

const GATED_TYPES: ReadonlySet<AdminUsersBulkAction['type']> = new Set(['suspend', 'contain', 'adjustCredits']);
const GATED_AUDIT_ACTIONS = [...GATED_TYPES].map(type => AUDIT_ACTION[type]);
const HOUR_MS = 60 * 60 * 1000;

export const usersBulkApprovalPermission = (action: AdminUsersBulkAction): AdminPermissionId =>
  action.type === 'adjustCredits' ? 'credits:adjust' : 'users:moderate';

export type UsersBulkGate = { pending: ApprovalPendingBody } | { pending: null; release: ReleaseWindow };
const RUN_BULK_NOW: UsersBulkGate = { pending: null, release: RUN_NOW.release };

/**
 * Stores the execute for a second admin when approvals are on and it acts on more users (or adds more
 * credits) than the thresholds allow, counting what this admin moved or is moving over the expiry window.
 * Otherwise the batch runs now with its users and credits reserved until `release`. The cohort is checked
 * first with the same 400/409 refusals execute uses, and stored as its sorted ids so a filter cannot drift.
 */
export async function requestUsersBulkApprovalIfNeeded(
  req: Request,
  request: AdminUsersBulkExecuteRequest,
  deps: ResolveDeps = usersBulkResolveDeps
): Promise<UsersBulkGate> {
  if (!GATED_TYPES.has(request.action.type)) return RUN_BULK_NOW;
  const policy = await getApprovalPolicy();
  if (!policy.enabled) return RUN_BULK_NOW;
  if (!req.user) throw new ForbiddenError('Unauthorized. Admin access required.');
  const actorId = req.user.id;

  const users = await confirmedCohort(request, { id: actorId, selfIds: selfIdsOf(req.user) }, deps, new Date());
  const windowMs = policy.expiryHours * HOUR_MS;
  const since = new Date(Date.now() - windowMs);
  const releaseUsers = await reserveWithinWindow(
    actorId,
    'users',
    users.length,
    policy.bulkUserThreshold,
    windowMs,
    () => adminAuditLogRepository.countActions(actorId, GATED_AUDIT_ACTIONS, since)
  );
  const credits =
    releaseUsers && request.action.type === 'adjustCredits'
      ? await creditGrantNeedsApproval(netCreditsAdded(request.action, users), actorId).catch(async error => {
          await releaseUsers();
          throw error;
        })
      : RUN_NOW;
  if (releaseUsers && !credits.policy) {
    const releaseCredits = credits.release;
    return {
      pending: null,
      release: async () => {
        await Promise.all([releaseUsers(), releaseCredits()]);
      },
    };
  }
  await releaseUsers?.();

  const userIds = users.map(user => user.id).sort();
  const pending = await requestApproval(
    req,
    {
      action: 'users.bulk',
      params: { ...request, target: { kind: 'ids', userIds } },
      summary: `Bulk ${request.action.type} of ${userIds.length} users`,
      reason: request.reason,
      requiredPermission: usersBulkApprovalPermission(request.action),
      requiresFullAdmin: true,
    },
    policy
  );
  return { pending };
}
