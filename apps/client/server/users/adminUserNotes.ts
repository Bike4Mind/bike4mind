import type { Request } from 'express';
import { Types } from 'mongoose';
import {
  AdminNoteChangeSchema,
  AdminNoteCreateSchema,
  AdminNoteIdSchema,
  AdminNotePageQuerySchema,
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '@bike4mind/common';
import {
  AdminUserNoteModel,
  AdminUserNoteRevisionModel,
  User,
  withTransaction,
  toAdminUserNote,
  toAdminUserNoteRevision,
} from '@bike4mind/database';
import { requireAdminPermission } from '@server/middlewares/adminApi';
import { recordAdminActionFromRequest } from '@server/utils/adminAudit';

export const noteSubject = async (req: Request, permission: 'support:read' | 'users:moderate' | 'settings:manage') => {
  requireAdminPermission(req, permission);
  const parsed = AdminNoteIdSchema.safeParse(req.query.userId);
  if (!parsed.success) throw new BadRequestError('Invalid user id');
  const user = await User.findById(parsed.data).select('name username isAdmin adminPermissions tags').lean();
  if (!user) throw new NotFoundError('User not found');
  return { userId: parsed.data, user };
};

export const listAdminUserNotes = async (req: Request) => {
  const { userId } = await noteSubject(req, 'support:read');
  const parsed = AdminNotePageQuerySchema.safeParse(req.query);
  if (!parsed.success) throw new BadRequestError('Invalid notes pagination');
  const { noteId, cursor, limit } = parsed.data;
  const bound = cursor ? { _id: { $lt: new Types.ObjectId(cursor) } } : {};
  if (noteId) {
    const rows = await AdminUserNoteRevisionModel.find({ userId, noteId, ...bound })
      .sort({ _id: -1 })
      .limit(limit + 1)
      .maxTimeMS(5000)
      .lean();
    return {
      entries: rows.slice(0, limit).map(toAdminUserNoteRevision),
      nextCursor: rows.length > limit ? rows[limit - 1]._id.toHexString() : null,
    };
  }
  const rows = await AdminUserNoteModel.find({ userId, deleted: false, ...bound })
    .sort({ _id: -1 })
    .limit(limit + 1)
    .maxTimeMS(5000)
    .lean();
  return {
    entries: rows.slice(0, limit).map(toAdminUserNote),
    nextCursor: rows.length > limit ? rows[limit - 1]._id.toHexString() : null,
  };
};

export const writeAdminUserNote = async (req: Request) => {
  const { userId } = await noteSubject(req, 'users:moderate');
  const parsed =
    req.method === 'POST' ? AdminNoteCreateSchema.safeParse(req.body) : AdminNoteChangeSchema.safeParse(req.body);
  if (!parsed.success) throw new BadRequestError('Invalid note action or body (1 to 2000 characters)');
  if (!req.user || req.user.impersonatedBy) throw new ForbiddenError('Notes require an administrator session');
  const actor = { id: req.user.id, name: req.user.name || req.user.username || req.user.id };
  const input = parsed.data;
  return withTransaction(async () => {
    const now = new Date();
    const change = 'noteId' in input ? input : undefined;
    const existing = change ? await AdminUserNoteModel.findOne({ _id: change.noteId, userId }).lean() : undefined;
    if (change && !existing) throw new NotFoundError('Note not found');
    if (change && existing && (existing.version !== change.version || (existing.deleted && change.deleted !== false)))
      throw new ConflictError('Note changed. Reload notes before trying again.');
    const action = !change
      ? 'created'
      : change.deleted === true
        ? 'deleted'
        : change.deleted === false
          ? 'restored'
          : 'edited';
    const note =
      existing && change
        ? await AdminUserNoteModel.findOneAndUpdate(
            { _id: existing._id, userId, version: change.version },
            {
              $set: {
                body: change.body ?? existing.body,
                deleted: change.deleted ?? existing.deleted,
                editor: actor,
                updatedAt: now,
              },
              $inc: { version: 1 },
            },
            { new: true, runValidators: true }
          )
        : await AdminUserNoteModel.create({
            userId,
            author: actor,
            editor: actor,
            body: input.body,
            version: 1,
            deleted: false,
            createdAt: now,
            updatedAt: now,
          });
    if (!note) throw new ConflictError('Note changed. Reload notes before trying again.');
    await AdminUserNoteRevisionModel.create({
      noteId: note._id.toString(),
      userId,
      author: note.author,
      editor: actor,
      body: note.body,
      version: note.version,
      deleted: note.deleted,
      createdAt: note.createdAt,
      updatedAt: now,
    });
    await recordAdminActionFromRequest(req, {
      action: `user.note.${action}`,
      target: { kind: 'user', id: userId, displayName: userId },
      summary: `${action} an internal note`,
      details: { noteId: note._id.toString(), version: note.version },
    });
    return toAdminUserNote(note);
  });
};
