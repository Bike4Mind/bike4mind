import type { Request } from 'express';
import { FeedbackModel, adminAuditLogRepository, withTransaction } from '@bike4mind/database';
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
  UpdateFeedbackStatusRequestSchema,
  FeedbackStatus,
  FEEDBACK_RESOLUTIONS,
  type AuditChange,
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
    const { status, expectedStatus, undoOf, reason } = parsed.data;

    const undone = undoOf ? await adminAuditLogRepository.findById(undoOf) : null;
    if (undoOf) {
      if (undone?.action !== 'feedback.status_changed' || undone.details?.feedbackId !== id) {
        throw new BadRequestError('undoOf must name a status change on this report');
      }
    }

    // Under impersonation req.user is the impersonated account; the report was handled by the admin.
    const adminId = req.user!.impersonatedBy ?? req.user!.id;

    const result = await withTransaction(async () => {
      const current = await FeedbackModel.findById(id)
        .select('userId status resolution resolutionDuplicateId handledBy handledAt handledAuditEntryId')
        .lean();
      if (!current) throw new NotFoundError('Feedback not found');
      const previousStatus = current.status as FeedbackStatus;
      if (expectedStatus && previousStatus !== expectedStatus) {
        throw new ConflictError(`This report is already ${previousStatus}. Refresh and try again.`);
      }
      // Resolution corrections use reopen/reclose so Undo keeps its status-transition contract.
      if (previousStatus === status) {
        return { previousStatus, handledBy: current.handledBy, handledAt: current.handledAt, auditEntryId: null };
      }
      // An undo only reverses the change it names, and only while the report still sits where that change left it.
      const reversed = undone?.changes?.[0];
      if (
        undone &&
        (current.handledAuditEntryId !== undoOf || reversed?.after !== previousStatus || reversed?.before !== status)
      ) {
        throw new ConflictError('This status change is no longer the latest one. Refresh and try again.');
      }

      const restoredResolution = undone?.changes?.find(change => change.field === 'resolution')?.before;
      const restoredDuplicateId = undone?.changes?.find(change => change.field === 'resolutionDuplicateId')?.before;
      const resolution =
        status === FeedbackStatus.Closed ? (undoOf ? restoredResolution : parsed.data.resolution) : undefined;
      const duplicateId =
        resolution === 'duplicate' ? (undoOf ? restoredDuplicateId : parsed.data.resolutionDuplicateId) : undefined;
      if (status === FeedbackStatus.Closed && !FEEDBACK_RESOLUTIONS.some(value => value === resolution)) {
        throw new BadRequestError('Choose a resolution before closing');
      }
      if (resolution === 'duplicate') {
        if (
          typeof duplicateId !== 'string' ||
          !isValidObjectId(duplicateId) ||
          duplicateId.toLowerCase() === id.toLowerCase()
        ) {
          throw new BadRequestError('Choose another report as the original');
        }
        if (!(await FeedbackModel.exists({ _id: duplicateId }))) throw new BadRequestError('Original report not found');
      }

      const changes: AuditChange[] = [{ field: 'status', before: previousStatus, after: status }];
      if (current.resolution !== resolution)
        changes.push({ field: 'resolution', before: current.resolution ?? null, after: resolution ?? null });
      if (current.resolutionDuplicateId !== duplicateId)
        changes.push({
          field: 'resolutionDuplicateId',
          before: current.resolutionDuplicateId ?? null,
          after: duplicateId ?? null,
        });

      const handledAt = new Date();
      const entry = await recordAdminActionFromRequest(req, {
        action: 'feedback.status_changed',
        target: await userAuditTarget(current.userId),
        summary: undoOf
          ? `undid a feedback status change: ${previousStatus} back to ${status}`
          : `changed feedback status from ${previousStatus} to ${status}`,
        changes,
        reason,
        details: { feedbackId: id, ...(undoOf ? { undoOf } : {}) },
      });
      if (!entry) throw new Error('Feedback status change requires an audit entry');
      const { matchedCount } = await FeedbackModel.updateOne(
        { _id: id, status: previousStatus },
        {
          $set: {
            status,
            handledBy: adminId,
            handledAt,
            handledAuditEntryId: entry.id,
            ...(resolution ? { resolution, ...(duplicateId ? { resolutionDuplicateId: duplicateId } : {}) } : {}),
          },
          $unset: {
            ...(!resolution ? { resolution: '' } : {}),
            ...(!duplicateId ? { resolutionDuplicateId: '' } : {}),
          },
        }
      );
      if (matchedCount === 0) throw new ConflictError('This report changed while saving. Refresh and try again.');

      return { previousStatus, handledBy: adminId, handledAt, auditEntryId: entry.id };
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
