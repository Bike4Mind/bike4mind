import { ADMIN_NOTE_MAX_LENGTH } from '@bike4mind/common';
import mongoose, { Schema } from 'mongoose';

type FeedbackNote = {
  feedbackId: string;
  userId: string;
  author: { id: string; name: string };
  body: string;
  createdAt: Date;
  expiresAt: Date;
};

const schema = new Schema<FeedbackNote>(
  {
    feedbackId: { type: String, required: true, immutable: true, match: /^[a-f\d]{24}$/ },
    userId: { type: String, required: true, immutable: true, match: /^[a-f\d]{24}$/ },
    author: {
      type: new Schema(
        { id: { type: String, required: true }, name: { type: String, required: true } },
        { _id: false }
      ),
      required: true,
      immutable: true,
    },
    body: { type: String, required: true, immutable: true, maxlength: ADMIN_NOTE_MAX_LENGTH },
    createdAt: { type: Date, required: true, immutable: true },
    expiresAt: { type: Date, required: true, immutable: true },
  },
  { versionKey: false }
);
schema.index({ feedbackId: 1, createdAt: 1, _id: 1 }, { name: 'feedback_note_parent' });
schema.index({ userId: 1 }, { name: 'feedback_note_owner' });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'feedback_note_ttl' });

export const FeedbackNoteModel: mongoose.Model<FeedbackNote> =
  (mongoose.models.FeedbackNote as mongoose.Model<FeedbackNote> | undefined) ??
  mongoose.model<FeedbackNote>('FeedbackNote', schema);
