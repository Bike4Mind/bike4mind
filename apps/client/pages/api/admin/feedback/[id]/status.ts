import type { Request } from 'express';
import { FeedbackModel, adminAuditLogRepository, withTransaction } from '@bike4mind/database';
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
  UpdateFeedbackStatusRequestSchema,
  type FeedbackStatus,
  type UpdateFeedbackStatusResponse,
} from '@bike4mind/common';
import { adminApi } from '@server/middlewares/adminApi';
import { isValidObjectId } from '@bike4mind/server-utils/utils/objectId';
import { recordAdminActionFromRequest, userAuditTarget } from '@bike4mind/server-utils/utils/adminAudit';

/**
 * Sets a feedback report's triage status. Admin-only and status-only: the reporter's own edit path
 * (feedback/[id]/update.ts) cannot touch status, handledBy or handledAt. Every change is written to
 * the Admin log in the same transaction, so a report never moves without an entry naming who moved it.
 */
const handler = adminApi({ auth: 'jwtOnly', adminPermissions: { PATCH: 'users:moderate' } }).patch(
  async (req: Request, res) => {
    const id = String(req.query.id ?? '');
    if (!isValidObjectId(id)) throw new NotFoundError('Feedback not found');

    const parsed = UpdateFeedbackStatusRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw new BadRequestError(parsed.error.issues[0]?.message ?? 'Invalid status');
    const { status, expectedStatus, undoOf } = parsed.data;

    if (undoOf) {
      const undone = await adminAuditLogRepository.findById(undoOf);
      if (undone?.action !== 'feedback.status_changed' || undone.details?.feedbackId !== id) {
        throw new BadRequestError('undoOf must name a status change on this report');
      }
    }

    // Under impersonation req.user is the impersonated account; the report was handled by the admin.
    const adminId = req.user!.impersonatedBy ?? req.user!.id;

    const result = await withTransaction(async () => {
      const current = await FeedbackModel.findById(id).select('userId status handledBy handledAt').lean();
      if (!current) throw new NotFoundError('Feedback not found');
      const previousStatus = current.status as FeedbackStatus;
      if (expectedStatus && previousStatus !== expectedStatus) {
        throw new ConflictError(`This report is already ${previousStatus}. Refresh and try again.`);
      }
      if (previousStatus === status) {
        return { previousStatus, handledBy: current.handledBy, handledAt: current.handledAt, auditEntryId: null };
      }

      const handledAt = new Date();
      const { matchedCount } = await FeedbackModel.updateOne(
        { _id: id, status: previousStatus },
        { $set: { status, handledBy: adminId, handledAt } }
      );
      if (matchedCount === 0) throw new ConflictError('This report changed while saving. Refresh and try again.');

      const entry = await recordAdminActionFromRequest(req, {
        action: 'feedback.status_changed',
        target: await userAuditTarget(current.userId),
        summary: undoOf
          ? `undid a feedback status change: ${previousStatus} back to ${status}`
          : `changed feedback status from ${previousStatus} to ${status}`,
        changes: [{ field: 'status', before: previousStatus, after: status }],
        details: { feedbackId: id, ...(undoOf ? { undoOf } : {}) },
      });
      return { previousStatus, handledBy: adminId, handledAt, auditEntryId: entry?.id ?? null };
    });

    const response: UpdateFeedbackStatusResponse = {
      status,
      previousStatus: result.previousStatus,
      handledBy: result.handledBy ?? null,
      handledAt: result.handledAt ? new Date(result.handledAt).toISOString() : null,
      auditEntryId: result.auditEntryId,
    };
    return res.status(200).json(response);
  }
);

export const config = {
  api: { externalResolver: true },
};

export default handler;
