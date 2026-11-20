import { AdminNoteBodySchema, feedbackContentExpiresAt } from '@bike4mind/common';
import { withTransaction } from '@bike4mind/db-core';
import { Types, type ClientSession } from 'mongoose';
import { User } from '../models/auth/UserModel';
import { FeedbackModel } from '../models/social/FeedbackModel';
import { FeedbackTextModel } from '../models/social/FeedbackTextModel';
import { FeedbackNoteModel } from '../models/social/FeedbackNoteModel';
import { AdminAuditLogModel } from '../models/infra/admin/AdminAuditLogModel';

const OBJECT_ID = /^[a-f\d]{24}$/i;

/** Caller owns the transaction. Both deletion paths write these same documents. */
export async function lockFeedbackNoteParent(feedbackId: string, session: ClientSession) {
  if (!OBJECT_ID.test(feedbackId)) return null;
  const feedback = await FeedbackModel.findById(feedbackId).select('userId createdAt').session(session).lean();
  if (!feedback || !OBJECT_ID.test(feedback.userId)) return null;
  const userId = String(new Types.ObjectId(feedback.userId));
  const canonicalFeedbackId = String(feedback._id);
  const owner = await User.updateOne(
    { _id: userId, 'deletion.purgeStartedAt': null },
    { $inc: { __v: 1 } },
    { session, timestamps: false }
  );
  if (owner.matchedCount !== 1) return null;
  const parent = await FeedbackModel.updateOne(
    { _id: feedbackId, userId: feedback.userId },
    { $inc: { __v: 1 } },
    { session, timestamps: false }
  );
  if (parent.matchedCount !== 1) return null;
  const text = await FeedbackTextModel.findById(feedbackId).select('expiresAt').session(session).lean();
  const expiresAt = text?.expiresAt ?? (feedback.createdAt ? feedbackContentExpiresAt(feedback.createdAt) : null);
  if (!expiresAt || !Number.isFinite(expiresAt.getTime())) return null;
  return { feedback, feedbackId: canonicalFeedbackId, userId, expiresAt };
}

/**
 * Move old inline bodies without renewing retention. Safe to rerun after old writers drain.
 * Raw audit updates are deliberately confined here; application audit entries stay append-only.
 */
export async function scrubLegacyFeedbackNotes(options: { limit?: number; now?: Date } = {}) {
  const limit = options.limit ?? 500;
  if (!Number.isInteger(limit) || limit < 1 || limit > 5000) throw new Error('Invalid feedback note scrub limit');
  const now = options.now ?? new Date();
  const filter = { action: 'feedback.note_added', 'details.note': { $type: 'string' } };
  const rows = await AdminAuditLogModel.find(filter).select('_id').sort({ _id: 1 }).limit(limit).lean();
  let migrated = 0;
  let retired = 0;
  for (const row of rows) {
    const outcome = await withTransaction(async session => {
      const source = await AdminAuditLogModel.findOne({ _id: row._id, ...filter })
        .session(session)
        .lean();
      if (!source || typeof source.details?.note !== 'string') return 'unchanged';
      const rawFeedbackId = source.details.feedbackId;
      const feedbackId =
        typeof rawFeedbackId === 'string' && OBJECT_ID.test(rawFeedbackId)
          ? String(new Types.ObjectId(rawFeedbackId))
          : null;
      const parent = feedbackId ? await lockFeedbackNoteParent(feedbackId, session) : null;
      const parsedBody = AdminNoteBodySchema.safeParse(source.details.note);
      const canRetain = parent && parent.expiresAt > now && parsedBody.success;
      if (canRetain) {
        const expected = {
          feedbackId: parent.feedbackId,
          userId: parent.userId,
          author: { id: source.actor.userId ?? source.actor.apiKeyId ?? 'system', name: source.actor.name },
          body: parsedBody.data,
          createdAt: source.occurredAt,
          expiresAt: parent.expiresAt,
        };
        const existing = await FeedbackNoteModel.findById(source._id).session(session).lean();
        if (existing) {
          if (
            existing.feedbackId !== expected.feedbackId ||
            existing.userId !== expected.userId ||
            existing.body !== expected.body ||
            existing.createdAt.getTime() !== expected.createdAt.getTime() ||
            existing.expiresAt.getTime() !== expected.expiresAt.getTime() ||
            existing.author.id !== expected.author.id ||
            existing.author.name !== expected.author.name
          ) {
            throw new Error('Feedback note migration destination conflicts with its audit record');
          }
        } else {
          await FeedbackNoteModel.create([{ _id: source._id, ...expected }], { session });
        }
      }
      if (!canRetain) {
        const existing = await FeedbackNoteModel.findById(source._id).session(session).lean();
        if (existing && existing.feedbackId !== feedbackId) {
          throw new Error('Feedback note migration destination conflicts with its audit record');
        }
        await FeedbackNoteModel.deleteOne({ _id: source._id }, { session });
      }
      const result = await AdminAuditLogModel.collection.updateOne(
        { _id: source._id, ...filter, 'details.note': source.details.note },
        {
          $unset: { 'details.note': '' },
          ...(feedbackId
            ? {
                $set: {
                  'details.feedbackId': feedbackId,
                  ...(canRetain ? { 'details.noteId': String(source._id) } : {}),
                },
              }
            : {}),
        },
        { session }
      );
      if (result.modifiedCount !== 1) throw new Error('Feedback note migration source changed');
      return canRetain ? 'migrated' : 'retired';
    });
    if (outcome === 'migrated') migrated++;
    if (outcome === 'retired') retired++;
  }
  return { scanned: rows.length, migrated, retired };
}
