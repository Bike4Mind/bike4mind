import type { AdminApproval } from '@bike4mind/common';
import type { Request } from 'express';
import { requestAuditWriter, type AdminAuditWriter } from '@server/utils/adminAudit';

export const approvalAuditDetails = (approval: AdminApproval) => ({
  id: approval.id,
  requestedBy: { id: approval.requestedBy.id, name: approval.requestedBy.name, email: approval.requestedBy.email },
});

/** The approver's audit writer, with every row it writes pointing back at the approval. */
export const approvalAuditWriter = (req: Request, approval: AdminApproval): AdminAuditWriter => {
  const write = requestAuditWriter(req);
  return (input, options) =>
    write({ ...input, details: { ...input.details, approval: approvalAuditDetails(approval) } }, options);
};
