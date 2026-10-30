import mongoose, { Schema, Types } from 'mongoose';
import { ADMIN_NOTE_MAX_LENGTH, type AdminUserNote, type AdminUserNoteRevision } from '@bike4mind/common';

type Identity = { id: string; name: string };
export type AdminUserNoteRecord = {
  userId: string;
  author: Identity;
  editor: Identity;
  body: string;
  version: number;
  deleted: boolean;
  createdAt: Date;
  updatedAt: Date;
};
type RevisionRecord = AdminUserNoteRecord & { noteId: string };
const identity = new Schema(
  { id: { type: String, required: true }, name: { type: String, required: true } },
  { _id: false }
);
const fields = {
  userId: { type: String, required: true, immutable: true },
  author: { type: identity, required: true, immutable: true },
  editor: { type: identity, required: true },
  body: { type: String, required: true, maxlength: ADMIN_NOTE_MAX_LENGTH },
  version: { type: Number, required: true, min: 1 },
  deleted: { type: Boolean, required: true },
  createdAt: { type: Date, required: true, immutable: true },
  updatedAt: { type: Date, required: true },
};
const noteSchema = new Schema<AdminUserNoteRecord>(fields, { versionKey: false });
noteSchema.index({ userId: 1, deleted: 1, _id: -1 });
const revisionSchema = new Schema<RevisionRecord>(
  { ...fields, noteId: { type: String, required: true, immutable: true } },
  { versionKey: false }
);
revisionSchema.index({ userId: 1, noteId: 1, _id: -1 });
revisionSchema.index({ noteId: 1, version: 1 }, { unique: true });
const immutable = () => {
  throw new Error('Note revisions are immutable');
};
revisionSchema.pre(
  [
    'updateOne',
    'updateMany',
    'findOneAndUpdate',
    'replaceOne',
    'findOneAndReplace',
    'deleteOne',
    'deleteMany',
    'findOneAndDelete',
  ],
  immutable
);
revisionSchema.pre('bulkWrite', immutable);
revisionSchema.pre('save', function () {
  if (!this.isNew) immutable();
});

export const AdminUserNoteModel: mongoose.Model<AdminUserNoteRecord> =
  (mongoose.models.AdminUserNote as mongoose.Model<AdminUserNoteRecord> | undefined) ??
  mongoose.model<AdminUserNoteRecord>('AdminUserNote', noteSchema);
export const AdminUserNoteRevisionModel: mongoose.Model<RevisionRecord> =
  (mongoose.models.AdminUserNoteRevision as mongoose.Model<RevisionRecord> | undefined) ??
  mongoose.model<RevisionRecord>('AdminUserNoteRevision', revisionSchema);

export const toAdminUserNote = (note: AdminUserNoteRecord & { _id: Types.ObjectId }): AdminUserNote => ({
  id: note._id.toHexString(),
  author: { id: note.author.id, name: note.author.name },
  createdAt: note.createdAt.toISOString(),
  updatedAt: note.updatedAt.toISOString(),
  body: note.body,
  version: note.version,
  deleted: note.deleted,
});
export const toAdminUserNoteRevision = (note: RevisionRecord & { _id: Types.ObjectId }): AdminUserNoteRevision => ({
  ...toAdminUserNote(note),
  id: note.noteId,
  editor: { id: note.editor.id, name: note.editor.name },
});
