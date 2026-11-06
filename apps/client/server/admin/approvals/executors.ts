import { ConflictError, type AdminApproval, type AdminApprovalAction } from '@bike4mind/common';
import type { Request } from 'express';

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
  'users.bulk': notExecutableOnApprove('users.bulk'),
  'org.credits.grant': notExecutableOnApprove('org.credits.grant'),
  'org.credits.top_up': notExecutableOnApprove('org.credits.top_up'),
  'user.subscription.grant': notExecutableOnApprove('user.subscription.grant'),
  // Approving only unlocks it: the requester redeems it themselves, so the session is never the approver's.
  'user.impersonate_admin': notExecutableOnApprove('user.impersonate_admin'),
  'user.delete_admin': notExecutableOnApprove('user.delete_admin'),
};
