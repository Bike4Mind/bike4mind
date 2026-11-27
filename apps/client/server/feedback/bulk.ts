import { createHash } from 'node:crypto';
import type { Request } from 'express';
import {
  FeedbackModel,
  FeedbackNoteModel,
  FeedbackAiModel,
  FeedbackTextModel,
  withTransaction,
} from '@bike4mind/database';
import { BadRequestError, ConflictError, type AuditChange } from '@bike4mind/common';
import { recordAdminActionFromRequest, userAuditTarget } from '@bike4mind/server-utils/utils/adminAudit';
import { buildFeedbackListFilter } from '@server/utils/feedbackListFilter';
import {
  FEEDBACK_BULK_MAX_REPORTS,
  FeedbackBulkRequestSchema,
  type FeedbackBulkResponse,
} from '@client/app/components/admin/Feedback/feedbackBulk';

export async function feedbackBulk(req: Request): Promise<FeedbackBulkResponse> {
  const parsed = FeedbackBulkRequestSchema.safeParse(req.body);
  if (!parsed.success) throw new BadRequestError(parsed.error.issues[0]?.message ?? 'Invalid bulk request');
  const body = parsed.data;
  return withTransaction(async () => {
    const filter =
      body.selection.mode === 'explicit'
        ? { _id: { $in: body.selection.ids } }
        : await buildFeedbackListFilter(body.selection.filters, {}, true);
    const reports = await FeedbackModel.find(filter)
      .select('userId status type resolution resolutionDuplicateId updatedAt')
      .sort({ _id: 1 })
      .limit(FEEDBACK_BULK_MAX_REPORTS + 1)
      .lean();
    if (reports.length > FEEDBACK_BULK_MAX_REPORTS)
      throw new BadRequestError(
        `Select at most ${FEEDBACK_BULK_MAX_REPORTS} reports. Narrow the filters and try again.`
      );
    if (body.selection.mode === 'explicit' && reports.length !== body.selection.ids.length)
      throw new ConflictError('Selected reports changed. Refresh and preview again.');
    const change = body.change;
    const affected = reports.filter(report => change.action === 'delete' || report.status !== change.status);
    if (change.action === 'status' && change.resolution === 'duplicate') {
      const originalId = change.resolutionDuplicateId!;
      if (reports.some(report => String(report._id) === originalId))
        throw new BadRequestError('The original report cannot be in the selection');
      if (!(await FeedbackModel.exists({ _id: originalId }))) throw new BadRequestError('Original report not found');
    }
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          change,
          reports: reports.map(report => [
            String(report._id),
            report.updatedAt,
            report.status,
            report.resolution,
            report.resolutionDuplicateId,
          ]),
        })
      )
      .digest('hex');
    const count = affected.length;
    if (body.preview) return { count, fingerprint, applied: false };
    if (body.expectedCount !== count || body.fingerprint !== fingerprint)
      throw new ConflictError('The selection changed. Preview again before applying.');

    for (const report of affected) {
      const id = String(report._id);
      const changes: AuditChange[] =
        change.action === 'status'
          ? [
              { field: 'status', before: report.status, after: change.status },
              { field: 'resolution', before: report.resolution ?? null, after: change.resolution ?? null },
              {
                field: 'resolutionDuplicateId',
                before: report.resolutionDuplicateId ?? null,
                after: change.resolutionDuplicateId ?? null,
              },
            ]
          : [];
      const entry = await recordAdminActionFromRequest(req, {
        action: change.action === 'delete' ? 'feedback.deleted' : 'feedback.status_changed',
        target: await userAuditTarget(report.userId),
        summary:
          change.action === 'delete'
            ? `deleted a ${report.type ?? 'feedback'} report (${report.status})`
            : `changed feedback status from ${report.status} to ${change.status}`,
        reason: body.reason!,
        changes,
        details: {
          feedbackId: id,
          bulk: true,
          ...(change.action === 'delete' ? { status: report.status, type: report.type ?? null } : {}),
        },
      });
      if (!entry) throw new Error('Feedback bulk action requires an audit entry');
      if (change.action === 'delete') {
        const deleted = await FeedbackModel.deleteOne({ _id: report._id, status: report.status });
        if (deleted.deletedCount !== 1) throw new ConflictError('Report changed. Preview again.');
        await FeedbackNoteModel.deleteMany({ feedbackId: id });
        await FeedbackAiModel.deleteMany({ feedbackId: id });
        await FeedbackTextModel.deleteOne({ _id: report._id });
      } else {
        const updated = await FeedbackModel.updateOne(
          { _id: report._id, status: report.status },
          {
            $set: {
              status: change.status,
              handledBy: req.user!.impersonatedBy ?? req.user!.id,
              handledAt: new Date(),
              handledAuditEntryId: entry.id,
              ...(change.resolution ? { resolution: change.resolution } : {}),
              ...(change.resolutionDuplicateId ? { resolutionDuplicateId: change.resolutionDuplicateId } : {}),
            },
            $unset: {
              ...(!change.resolution ? { resolution: '' } : {}),
              ...(!change.resolutionDuplicateId ? { resolutionDuplicateId: '' } : {}),
            },
          }
        );
        if (updated.matchedCount !== 1) throw new ConflictError('Report changed. Preview again.');
      }
    }
    return { count, fingerprint, applied: true };
  });
}
