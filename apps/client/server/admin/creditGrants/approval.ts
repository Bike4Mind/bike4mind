import type { AdminApproval } from '@bike4mind/common';
import type { Request } from 'express';
import { approvalAuditDetails } from '@server/admin/approvals/auditWriter';

/** Audit details pointing a grant made on approval back at its approval record. */
export const approvalDetails = (approval?: AdminApproval) =>
  approval ? { approval: approvalAuditDetails(approval) } : {};

/** Client refreshes after a grant commits: a failed push is logged, never reported as a failed grant. */
export async function notifyAfterCommit(req: Request, send: () => Promise<unknown>) {
  try {
    await send();
  } catch (error) {
    req.logger.error('[ADMIN_GRANT_NOTIFY_FAILED]', { error });
  }
}
