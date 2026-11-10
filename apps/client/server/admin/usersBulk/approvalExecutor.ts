import { ForbiddenError, isFullAdmin } from '@bike4mind/common';
import { userRepository } from '@bike4mind/database';
import { AdminUsersBulkExecuteRequestSchema, blocksEmailDomains } from '@client/app/utils/adminUsersBulk';
import { approvalAuditWriter } from '@server/admin/approvals/auditWriter';
import type { ApprovalExecutor } from '@server/admin/approvals/executors';
import { selfIdsOf } from './actor';
import { usersBulkExecuteDepsFor } from './adapters';
import { assertCanRunUsersBulkAction } from './authorize';
import { executeAdminUsersBulk } from './execute';

/**
 * Runs an approved bulk execute as the approver. Neither admin is ever acted on, and a cohort that
 * changed since the request is a 409, so the approval fails and a new request is needed.
 */
export const executeApprovedUsersBulk: ApprovalExecutor = async (params, { req, approval }) => {
  const request = AdminUsersBulkExecuteRequestSchema.parse(params);
  if (!req.user) throw new ForbiddenError('Unauthorized. Admin access required.');
  assertCanRunUsersBulkAction(req, request.action.type, { blocks: blocksEmailDomains(request.action) });
  const selfIds = [...new Set([...selfIdsOf(req.user), ...approval.requestedBy.selfIds])];
  // Delegated-admin accounts stay in the cohort only when both admins could act on them; a cohort the
  // requester's preview resolved differently is then a 409, as for any cohort that changed.
  const fullAdmin = isFullAdmin(req.user) && isFullAdmin(await userRepository.findById(approval.requestedBy.id));
  return executeAdminUsersBulk(
    request,
    { id: req.user.id, selfIds, fullAdmin },
    usersBulkExecuteDepsFor(approvalAuditWriter(req, approval), request.reason, req.logger)
  );
};
