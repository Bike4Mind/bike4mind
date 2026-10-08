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

// `_id` breaks publishAt ties so keyset pages are stable. Replaces the old { status, publishAt }
// index, which the 20260921235998 migration drops.
ReleaseNoteSchema.index({ status: 1, publishAt: -1, _id: -1 }, { name: 'status_publishAt_id' });

export const ReleaseNote =
  (mongoose.models.ReleaseNote as mongoose.Model<IReleaseNoteDocument>) ||
  model<IReleaseNoteDocument>('ReleaseNote', ReleaseNoteSchema);

export type GeneratedReleaseNote = Omit<ReleaseNoteData, 'editedAt'>;

/** Decoded keyset cursor: the last row of the previous page. */
export interface ReleaseNoteKeyset {
  publishAt: Date;
  id: string;
}

export interface ReleaseNotePage {
  items: IReleaseNoteDocument[];
  hasMore: boolean;
}

/** Admin view of a note's lifecycle; `published` is derived (scheduled and past publishAt). */
export type ReleaseNoteAdminStatus = 'scheduled' | 'hidden' | 'published';

export type ReleaseNoteMutationResult =
  { kind: 'ok'; note: IReleaseNoteDocument } | { kind: 'notFound' } | { kind: 'emptyItems' };

export type ReleaseNoteEdit = Partial<Pick<ReleaseNoteData, 'headline' | 'summary' | 'items'>>;

const PAGE_SORT = { publishAt: -1, _id: -1 } as const;

const afterKeyset = (after: ReleaseNoteKeyset) => ({
  $or: [
    { publishAt: { $lt: after.publishAt } },
    { publishAt: after.publishAt, _id: { $lt: new mongoose.Types.ObjectId(after.id) } },
  ],
});

const isDuplicateKeyError = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 11000;

export class ReleaseNoteRepository extends BaseRepository<IReleaseNoteDocument> {
  constructor(model: Model<IReleaseNoteDocument>) {
    super(model);
  }

  /**
   * Writes a generated note unless a human has edited the stored one. The filter only matches an
   * unedited row, so for an edited tag the upsert tries an insert and hits the unique releaseTag
   * index. An E11000 means "preserved" only when the stored row is edited; otherwise a concurrent
   * insert won the race, and the update is retried against that row.
   */
  async upsertGenerated(note: GeneratedReleaseNote): Promise<{ note: IReleaseNoteDocument; preserved: boolean }> {
    const filter = { releaseTag: note.releaseTag, editedAt: null };
    const update = { $set: { ...note, editedAt: null } };
    try {
      const saved = await this.model.findOneAndUpdate(filter, update, {
        upsert: true,
        new: true,
        runValidators: true,
        setDefaultsOnInsert: true,
      });
      return { note: saved, preserved: false };
    } catch (err) {
      if (!isDuplicateKeyError(err)) throw err;
      const saved = await this.model.findOneAndUpdate(filter, update, { new: true, runValidators: true });
      if (saved) return { note: saved, preserved: false };
      const existing = await this.model.findOne({ releaseTag: note.releaseTag });
      if (!existing) throw err;
      return { note: existing, preserved: true };
    }
  }

  /** Notes readers may see at `now`: scheduled and past their embargo, newest first. */
  async findPublished(now: Date, limit = 20): Promise<IReleaseNoteDocument[]> {
    return (await this.listPublished({ now, limit })).items;
  }

  /** Keyset page of published notes, ordered (publishAt, _id) descending. */
  async listPublished({
    now,
    after,
    limit,
  }: {
    now: Date;
    after?: ReleaseNoteKeyset;
    limit: number;
  }): Promise<ReleaseNotePage> {
    return this.page({ status: 'scheduled', publishAt: { $lte: now } }, after, limit);
  }

  async adminList({
    status,
    now,
    after,
    limit,
  }: {
    status: ReleaseNoteAdminStatus;
    now: Date;
    after?: ReleaseNoteKeyset;
    limit: number;
  }): Promise<ReleaseNotePage> {
    const filter =
      status === 'hidden'
        ? { status: 'hidden' }
        : { status: 'scheduled', publishAt: status === 'published' ? { $lte: now } : { $gt: now } };
    return this.page(filter, after, limit);
  }

  /*
   * Every admin mutation below stamps editedAt, so upsertGenerated (which only matches editedAt:null)
   * never overwrites an admin decision: an edited or hidden note survives regeneration of its tag.
   */

  /** Edits copy. Emptying `items` is refused unless the note is hidden, so nothing empty goes live. */
  async edit(id: string, edit: ReleaseNoteEdit): Promise<ReleaseNoteMutationResult> {
    const emptiesItems = edit.items !== undefined && edit.items.length === 0;
    const filter = emptiesItems ? { _id: id, status: 'hidden' } : { _id: id };
    const note = await this.model.findOneAndUpdate(
      filter,
      { $set: { ...edit, editedAt: new Date() } },
      { new: true, runValidators: true }
    );
    return note ? { kind: 'ok', note } : this.notFoundOrEmptyItems(id);
  }

  async hide(id: string): Promise<ReleaseNoteMutationResult> {
    const note = await this.model.findOneAndUpdate(
      { _id: id },
      { $set: { status: 'hidden', editedAt: new Date() } },
      { new: true, runValidators: true }
    );
    return note ? { kind: 'ok', note } : { kind: 'notFound' };
  }

  /**
   * Back to scheduled with its original publishAt, or `now` if that has passed, so an unhidden note
   * never goes live behind cursors readers already hold. A note that is not hidden keeps its publishAt.
   * A note with no items is refused.
   */
  async unhide(id: string, now = new Date()): Promise<ReleaseNoteMutationResult> {
    const hasItems = { 'items.0': { $exists: true } };
    const notHidden = await this.model.findOneAndUpdate(
      { _id: id, ...hasItems, status: 'scheduled' },
      { $set: { editedAt: now } },
      { new: true, runValidators: true }
    );
    if (notHidden) return { kind: 'ok', note: notHidden };
    const note = await this.model.findOneAndUpdate(
      { _id: id, ...hasItems },
      { $set: { status: 'scheduled', editedAt: now }, $max: { publishAt: now } },
      { new: true, runValidators: true }
    );
    return note ? { kind: 'ok', note } : this.notFoundOrEmptyItems(id);
  }

  /**
   * Makes the note live at `now`. An already-live note keeps its publishAt, so its feed position and
   * existing reader cursors stay valid; a hidden or future one moves to `now`, the top of the feed.
   */
  async publishNow(id: string, now = new Date()): Promise<ReleaseNoteMutationResult> {
    const hasItems = { 'items.0': { $exists: true } };
    const live = await this.model.findOneAndUpdate(
      { _id: id, ...hasItems, status: 'scheduled', publishAt: { $lte: now } },
      { $set: { editedAt: now } },
      { new: true, runValidators: true }
    );
    if (live) return { kind: 'ok', note: live };
    const note = await this.model.findOneAndUpdate(
      { _id: id, ...hasItems },
      { $set: { status: 'scheduled', publishAt: now, editedAt: now } },
      { new: true, runValidators: true }
    );
    return note ? { kind: 'ok', note } : this.notFoundOrEmptyItems(id);
  }

  private async notFoundOrEmptyItems(id: string): Promise<ReleaseNoteMutationResult> {
    return (await this.model.exists({ _id: id })) ? { kind: 'emptyItems' } : { kind: 'notFound' };
  }

  private async page(
    filter: Record<string, unknown>,
    after: ReleaseNoteKeyset | undefined,
    limit: number
  ): Promise<ReleaseNotePage> {
    const rows = await this.model
      .find(after ? { ...filter, ...afterKeyset(after) } : filter)
      .sort(PAGE_SORT)
      .limit(limit + 1);
    return { items: rows.slice(0, limit), hasMore: rows.length > limit };
  }
}

export const releaseNoteRepository = new ReleaseNoteRepository(ReleaseNote);
export default ReleaseNote;
