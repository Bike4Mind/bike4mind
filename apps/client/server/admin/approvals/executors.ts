import { ConflictError, type AdminApproval, type AdminApprovalAction } from '@bike4mind/common';
import type { Request } from 'express';
import { GrantOrgParamsSchema, grantOrg } from '@server/admin/creditGrants/grantOrg';
import { GrantSubscriptionParamsSchema, grantSubscription } from '@server/admin/creditGrants/grantSubscription';
import { TopUpParamsSchema, topUpOrg } from '@server/admin/creditGrants/topUpOrg';
import { executeApprovedUsersBulk } from '@server/admin/usersBulk/approvalExecutor';
import { ScheduleAdminDeletionParamsSchema, scheduleDeletionAsAdmin } from '@server/admin/scheduleDeletionAsAdmin';
import { DeleteAdminParamsSchema, executeApprovedAdminDelete } from '@server/admin/deleteUserAsAdmin';

/** `req` is the approver's request: the approver's live session runs the stored params. */
export type ApprovalExecutionContext = { req: Request; approval: AdminApproval };
export type ApprovalExecutor = (params: unknown, context: ApprovalExecutionContext) => Promise<unknown>;

const notExecutableOnApprove =
  (action: AdminApprovalAction): ApprovalExecutor =>
  async () => {
    throw new ConflictError(`${action} cannot be executed by an approver`);
  };

/** One entry per gated action; the gated route's own module supplies the real executor. */
export const approvalExecutors: Record<AdminApprovalAction, ApprovalExecutor> = {
  'users.bulk': (params, context) => executeApprovedUsersBulk(params, context),
  'org.credits.grant': (params, { req, approval }) => grantOrg(req, GrantOrgParamsSchema.parse(params), approval),
  'org.credits.top_up': (params, { req, approval }) => topUpOrg(req, TopUpParamsSchema.parse(params), approval),
  'user.subscription.grant': (params, { req, approval }) =>
    grantSubscription(req, GrantSubscriptionParamsSchema.parse(params), approval),
  // Approving only unlocks it: the requester redeems it in loginAs, so the session is never the approver's.
  'user.impersonate_admin': notExecutableOnApprove('user.impersonate_admin'),
  'user.schedule_admin_deletion': (params, { req, approval }) =>
    scheduleDeletionAsAdmin(req, ScheduleAdminDeletionParamsSchema.parse(params), approval),
  'user.delete_admin': (params, { req, approval }) =>
    executeApprovedAdminDelete(req, DeleteAdminParamsSchema.parse(params), approval),
};
