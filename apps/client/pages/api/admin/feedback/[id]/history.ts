import type { Request } from 'express';
import { z } from 'zod';
import {
  AddFeedbackNoteRequestSchema,
  ADMIN_NOTE_MAX_LENGTH,
  BadRequestError,
  NotFoundError,
  type FeedbackHistoryItem,
  type FeedbackHistoryPage,
} from '@bike4mind/common';
import {
  FeedbackModel,
  FeedbackNoteModel,
  lockFeedbackNoteParent,
  adminAuditLogRepository,
  withTransaction,
} from '@bike4mind/database';
import { adminApi } from '@server/middlewares/adminApi';
import { isValidObjectId } from '@bike4mind/server-utils/utils/objectId';
import { recordAdminActionFromRequest, userAuditTarget } from '@bike4mind/server-utils/utils/adminAudit';

const cursorSchema = z.object({ at: z.iso.datetime(), id: z.string().regex(/^[a-f\d]{24}$/i) });

async function report(req: Request) {
  const id = String(req.query.id ?? '');
  if (!isValidObjectId(id)) throw new NotFoundError('Feedback not found');
  const feedback = await FeedbackModel.findById(id).select('userId').lean();
  if (!feedback) throw new NotFoundError('Feedback not found');
  return { id: String(feedback._id), feedback };
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
    const noteIds = page.entries.flatMap(entry =>
      entry.action === 'feedback.note_added' &&
      typeof entry.details?.noteId === 'string' &&
      isValidObjectId(entry.details.noteId)
        ? [entry.details.noteId]
        : []
    );
    const notes = noteIds.length
      ? await FeedbackNoteModel.find({ _id: { $in: noteIds }, feedbackId: id, expiresAt: { $gt: new Date() } })
          .select('body')
          .lean()
      : [];
    const bodies = new Map(notes.map(note => [String(note._id), note.body]));
    const items: FeedbackHistoryItem[] = page.entries.map(entry => ({
      id: entry.id,
      occurredAt: entry.occurredAt.toISOString(),
      author: entry.actor.name,
      summary: entry.summary,
      ...(entry.reason ? { reason: entry.reason } : {}),
      ...(entry.action === 'feedback.note_added' &&
      typeof entry.details?.noteId === 'string' &&
      bodies.has(entry.details.noteId)
        ? { note: bodies.get(entry.details.noteId) }
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
    if (!parsed.success) throw new BadRequestError(`Write a note between 1 and ${ADMIN_NOTE_MAX_LENGTH} characters`);
    const entry = await withTransaction(async session => {
      const id = String(req.query.id ?? '');
      const parent = await lockFeedbackNoteParent(id, session);
      if (!parent) throw new NotFoundError('Feedback or its reporter is no longer available');
      const { feedbackId, userId, expiresAt } = parent;
      const now = new Date();
      if (expiresAt <= now)
        throw new BadRequestError('The report text retention period has ended; new note text cannot be stored');
      const [note] = await FeedbackNoteModel.create(
        [
          {
            feedbackId,
            userId,
            body: parsed.data.note,
            author: { id: req.user.id, name: req.user.username || req.user.name || req.user.id },
            createdAt: now,
            expiresAt,
          },
        ],
        { session }
      );
      const saved = await recordAdminActionFromRequest(req, {
        action: 'feedback.note_added',
        target: await userAuditTarget(userId),
        summary: 'added an internal feedback note',
        details: { feedbackId, noteId: String(note._id) },
      });
      if (!saved) throw new Error('Feedback note requires an audit entry');
      return saved;
    });
    return res.status(201).json({ auditEntryId: entry.id });
  });

export const config = { api: { externalResolver: true } };
export default handler;
