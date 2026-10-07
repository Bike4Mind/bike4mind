import mongoose, { Schema, model, Document, Model } from 'mongoose';
import type { ReleaseNote as ReleaseNoteData } from '@bike4mind/common';
import BaseRepository from '@bike4mind/db-core';

/** One customer-facing release note per production release tag. */
export interface IReleaseNoteDocument extends ReleaseNoteData, Document {
  id: string;
  createdAt: Date;
  updatedAt: Date;
}

const ReleaseNoteSchema = new Schema(
  {
    releaseTag: { type: String, required: true, unique: true },
    deployedSha: { type: String, required: true },
    deployedAt: { type: Date, required: true },
    headline: { type: String, default: '' },
    summary: { type: String, default: '' },
    items: [
      {
        _id: false,
        category: { type: String, enum: ['new', 'improved', 'fixed'], required: true },
        text: { type: String, required: true },
        importance: { type: Number, min: 1, max: 3, required: true },
        sourcePrs: { type: [Number], default: [] },
      },
    ],
    audience: { type: String, enum: ['public'], default: 'public' },
    status: { type: String, enum: ['scheduled', 'hidden'], required: true },
    publishAt: { type: Date, required: true },
    editedAt: { type: Date, default: null },
    schemaVersion: { type: Number, required: true },
  },
  {
    timestamps: true,
    collection: 'release_notes',
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

ReleaseNoteSchema.index({ status: 1, publishAt: -1 });

export const ReleaseNote =
  (mongoose.models.ReleaseNote as mongoose.Model<IReleaseNoteDocument>) ||
  model<IReleaseNoteDocument>('ReleaseNote', ReleaseNoteSchema);

export type GeneratedReleaseNote = Omit<ReleaseNoteData, 'editedAt'>;

const isDuplicateKeyError = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 11000;

export class ReleaseNoteRepository extends BaseRepository<IReleaseNoteDocument> {
  constructor(model: Model<IReleaseNoteDocument>) {
    super(model);
  }

  /**
   * Writes a generated note unless a human has edited the stored one. The filter only matches an
   * unedited row, so for an edited tag the upsert tries an insert and hits the unique releaseTag
   * index; that E11000 is the "preserved" signal, and the edited row is returned untouched.
   */
  async upsertGenerated(note: GeneratedReleaseNote): Promise<{ note: IReleaseNoteDocument; preserved: boolean }> {
    try {
      const saved = await this.model.findOneAndUpdate(
        { releaseTag: note.releaseTag, editedAt: null },
        { $set: { ...note, editedAt: null } },
        { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
      );
      return { note: saved, preserved: false };
    } catch (err) {
      if (!isDuplicateKeyError(err)) throw err;
      const existing = await this.model.findOne({ releaseTag: note.releaseTag });
      if (!existing) throw err;
      return { note: existing, preserved: true };
    }
  }

  /** Notes readers may see at `now`: scheduled and past their embargo, newest first. */
  async findPublished(now: Date, limit = 20): Promise<IReleaseNoteDocument[]> {
    return this.model
      .find({ status: 'scheduled', publishAt: { $lte: now } })
      .sort({ publishAt: -1 })
      .limit(limit);
  }
}

export const releaseNoteRepository = new ReleaseNoteRepository(ReleaseNote);
export default ReleaseNote;
