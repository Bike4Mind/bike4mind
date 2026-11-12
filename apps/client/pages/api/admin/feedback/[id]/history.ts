import type { Request } from 'express';
import { z } from 'zod';
import {
  AddFeedbackNoteRequestSchema,
  BadRequestError,
  NotFoundError,
  type FeedbackHistoryItem,
  type FeedbackHistoryPage,
} from '@bike4mind/common';
import { FeedbackModel, adminAuditLogRepository, withTransaction } from '@bike4mind/database';
import { adminApi } from '@server/middlewares/adminApi';
import { isValidObjectId } from '@bike4mind/server-utils/utils/objectId';
import { recordAdminActionFromRequest, userAuditTarget } from '@bike4mind/server-utils/utils/adminAudit';

const cursorSchema = z.object({ at: z.iso.datetime(), id: z.string().regex(/^[a-f\d]{24}$/i) });

async function report(req: Request) {
  const id = String(req.query.id ?? '');
  if (!isValidObjectId(id)) throw new NotFoundError('Feedback not found');
  const feedback = await FeedbackModel.findById(id).select('userId').lean();
  if (!feedback) throw new NotFoundError('Feedback not found');
  return { id, feedback };
}

const handler = adminApi({ auth: 'jwtOnly', adminPermissions: { GET: 'users:moderate', POST: 'users:moderate' } })
  .get(async (req, res) => {
    const { id } = await report(req);
    let cursor;
    if (req.query.cursor !== undefined) {
      try {
        const parsed = cursorSchema.parse(JSON.parse(String(req.query.cursor)));
        cursor = { occurredAt: new Date(parsed.at), id: parsed.id };
      } catch {
        throw new BadRequestError('Invalid history cursor');
      }
    }
    const page = await adminAuditLogRepository.listForFeedback(id, { limit: 25, cursor });
    const items: FeedbackHistoryItem[] = page.entries.map(entry => ({
      id: entry.id,
      occurredAt: entry.occurredAt.toISOString(),
      author: entry.actor.name,
      summary: entry.summary,
      ...(entry.reason ? { reason: entry.reason } : {}),
      ...(entry.action === 'feedback.note_added' && typeof entry.details?.note === 'string'
        ? { note: entry.details.note }
        : {}),
      changes: entry.changes,
    }));
    const response: FeedbackHistoryPage = {
      items,
      nextCursor: page.nextCursor
        ? JSON.stringify({ at: page.nextCursor.occurredAt.toISOString(), id: page.nextCursor.id })
        : null,
    };
    return res.json(response);
  })
  .post(async (req, res) => {
    const parsed = AddFeedbackNoteRequestSchema.safeParse(req.body);
    if (!parsed.success) throw new BadRequestError('Write a note between 1 and 2000 characters');
    const entry = await withTransaction(async () => {
      const { id, feedback } = await report(req);
      const saved = await recordAdminActionFromRequest(req, {
        action: 'feedback.note_added',
        target: await userAuditTarget(feedback.userId),
        summary: 'added an internal feedback note',
        details: { feedbackId: id, note: parsed.data.note },
      });
      if (!saved) throw new Error('Feedback note requires an audit entry');
      return saved;
    });
    return res.status(201).json({ auditEntryId: entry.id });
  });

export const config = { api: { externalResolver: true } };
export default handler;
