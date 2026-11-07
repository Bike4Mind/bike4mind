import { ForbiddenError } from '@bike4mind/common';
import { AdminSettings } from '@bike4mind/database/infra';
import { AdminUsersBulkExecuteRequestSchema, blocksEmailDomains } from '@client/app/utils/adminUsersBulk';
import { approvalAuditWriter } from '@server/admin/approvals/auditWriter';
import type { ApprovalExecutor } from '@server/admin/approvals/executors';
import { selfIdsOf } from './actor';
import { usersBulkExecuteDepsFor } from './adapters';
import { executeAdminUsersBulk } from './execute';

/**
 * Runs an approved bulk execute as the approver. Neither admin is ever acted on, and a cohort that
 * changed since the request is a 409, so the approval fails and a new request is needed.
 */
export const executeApprovedUsersBulk: ApprovalExecutor = async (params, { req, approval }) => {
  const request = AdminUsersBulkExecuteRequestSchema.parse(params);
  if (!req.user) throw new ForbiddenError('Unauthorized. Admin access required.');
  if (blocksEmailDomains(request.action) && !req.ability?.can('update', AdminSettings)) {
    throw new ForbiddenError('Blocking email domains needs permission to edit admin settings.');
  }
  const selfIds = [...new Set([...selfIdsOf(req.user), ...approval.requestedBy.selfIds])];
  return executeAdminUsersBulk(
    request,
    { id: req.user.id, selfIds },
    usersBulkExecuteDepsFor(approvalAuditWriter(req, approval), request.reason, req.logger)
  );
};
