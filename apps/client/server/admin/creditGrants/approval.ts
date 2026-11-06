import type { AdminApproval } from '@bike4mind/common';
import { approvalAuditDetails } from '@server/admin/approvals/auditWriter';

/** Audit details pointing a grant made on approval back at its approval record. */
export const approvalDetails = (approval?: AdminApproval) =>
  approval ? { approval: approvalAuditDetails(approval) } : {};
