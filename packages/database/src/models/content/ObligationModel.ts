import mongoose, { Schema } from 'mongoose';
import {
  OBLIGATION_DOCUMENT_KINDS,
  OBLIGATION_LIMITS,
  OBLIGATION_STATUSES,
  type ObligationDocumentKind,
  type ObligationStatus,
} from '@bike4mind/common';

/**
 * A scanned document the user handed to the assistant (POST /api/v1/obligations), with the fields the
 * model extracted and the user corrected. One per (user, file), so a retried hand-off reads the first row.
 * apps/workers/src/events/briefCompose.ts surfaces a confirmed one ahead of its due date.
 */
export type IObligation = {
  _id: mongoose.Types.ObjectId;
  userId: string;
  fileId: string;
  status: ObligationStatus;
  documentKind: ObligationDocumentKind;
  /** Major units; always set together with `currency`. */
  amountValue: number | null;
  currency: string | null;
  payee: string | null;
  /** Calendar due date stored as UTC midnight of that day. */
  dueDate: Date | null;
  destinationLakeId: string | null;
  destinationName: string | null;
  summary: string;
  model: string | null;
  confirmedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type ObligationInput = Pick<
  IObligation,
  | 'userId'
  | 'fileId'
  | 'documentKind'
  | 'amountValue'
  | 'currency'
  | 'payee'
  | 'dueDate'
  | 'destinationLakeId'
  | 'destinationName'
  | 'summary'
  | 'model'
> & { _id?: mongoose.Types.ObjectId };

export type ObligationUpdate = Partial<
  Pick<
    IObligation,
    | 'status'
    | 'amountValue'
    | 'currency'
    | 'payee'
    | 'dueDate'
    | 'destinationLakeId'
    | 'destinationName'
    | 'confirmedAt'
  >
>;

const schema = new Schema<IObligation>(
  {
    userId: { type: String, required: true },
    fileId: { type: String, required: true },
    status: { type: String, enum: OBLIGATION_STATUSES, required: true, default: 'pending' },
    documentKind: { type: String, enum: OBLIGATION_DOCUMENT_KINDS, required: true },
    amountValue: { type: Number, default: null, min: 0 },
    currency: { type: String, default: null, match: /^[A-Z]{3}$/ },
    payee: { type: String, default: null, maxlength: OBLIGATION_LIMITS.payee },
    dueDate: { type: Date, default: null },
    destinationLakeId: { type: String, default: null },
    destinationName: { type: String, default: null },
    summary: { type: String, default: '', maxlength: OBLIGATION_LIMITS.summary },
    model: { type: String, default: null },
    confirmedAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false, collection: 'Obligation' }
);

schema.index({ userId: 1, fileId: 1 }, { unique: true });
schema.index({ userId: 1, status: 1, dueDate: 1 });
schema.index({ userId: 1, _id: -1 });

export const ObligationModel =
  (mongoose.models.Obligation as mongoose.Model<IObligation> | undefined) ??
  mongoose.model<IObligation>('Obligation', schema);

function isDuplicateKey(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11000;
}

/** UTC midnight of a `YYYY-MM-DD` calendar day. */
export function obligationDayToDate(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

export const obligationRepository = {
  /** A concurrent hand-off of the same file loses the unique race and reads the winner's row. */
  async create(input: ObligationInput): Promise<{ obligation: IObligation; created: boolean }> {
    try {
      const created = await ObligationModel.create({ ...input, status: 'pending' });
      return { obligation: created.toObject(), created: true };
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
      const existing = await ObligationModel.findOne({ userId: input.userId, fileId: input.fileId }).lean();
      if (!existing) throw error;
      return { obligation: existing, created: false };
    }
  },

  /** Scoped to the owner: another user's id reads as missing. A malformed id is missing too. */
  async findByIdForUser(id: string, userId: string): Promise<IObligation | null> {
    if (!mongoose.isValidObjectId(id)) return null;
    return ObligationModel.findOne({ _id: id, userId }).lean();
  },

  async findByFileForUser(fileId: string, userId: string): Promise<IObligation | null> {
    return ObligationModel.findOne({ userId, fileId }).lean();
  },

  /** A dismissed obligation is final: the update matches nothing and returns null. */
  async applyUpdate(id: string, userId: string, set: ObligationUpdate): Promise<IObligation | null> {
    if (!mongoose.isValidObjectId(id)) return null;
    return ObligationModel.findOneAndUpdate(
      { _id: id, userId, status: { $ne: 'dismissed' } },
      { $set: set },
      { new: true, runValidators: true }
    ).lean();
  },

  /** Newest first. `cursor` is the last id of the previous page; a malformed one starts from the top. */
  async listForUser(
    userId: string,
    opts: { cursor?: string; limit: number; status?: ObligationStatus }
  ): Promise<IObligation[]> {
    const filter: Record<string, unknown> = { userId };
    if (opts.status) filter.status = opts.status;
    if (opts.cursor && mongoose.isValidObjectId(opts.cursor)) {
      filter._id = { $lt: new mongoose.Types.ObjectId(opts.cursor) };
    }
    return ObligationModel.find(filter).sort({ _id: -1 }).limit(opts.limit).lean();
  },

  /** Confirmed obligations due on a calendar day in `[fromDay, toDay]` (both `YYYY-MM-DD`), soonest first. */
  async listDueForBrief(userId: string, fromDay: string, toDay: string, limit: number): Promise<IObligation[]> {
    return ObligationModel.find({
      userId,
      status: 'confirmed',
      dueDate: { $gte: obligationDayToDate(fromDay), $lte: obligationDayToDate(toDay) },
    })
      .sort({ dueDate: 1, _id: 1 })
      .limit(limit)
      .lean();
  },
};
