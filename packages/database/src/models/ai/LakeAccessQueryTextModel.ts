import mongoose, { Schema } from 'mongoose';
import type { ILakeAccessQueryTextDocument } from '@bike4mind/common';

const ModelName = 'LakeAccessQueryText';

// See LakeAccessEventTypes.ts (ILakeAccessQueryText) for why this is a separate collection: a
// Mongo TTL index deletes the whole document it is declared on, so the event's long-lived
// metadata and this shorter-lived, more-sensitive text cannot share one document.
//
// `_id` is supplied explicitly (the owning LakeAccessEvent's `_id`), not auto-generated - a
// shared-`_id` join is a plain `findById`, needs no extra index, and makes "more than one query
// text per event" structurally impossible rather than merely disallowed.
const LakeAccessQueryTextSchema = new Schema<ILakeAccessQueryTextDocument>(
  {
    // No explicit `_id` path: Mongoose already gives every schema an ObjectId `_id` by default,
    // and `.create({ _id: eventId, ... })` (see LakeAccessEventModel.record) already works
    // against that default - declaring it here only conflicts with the generic Schema<T>'s
    // definition type, since `_id` isn't a key of ILakeAccessQueryTextDocument (that's `id`).
    queryText: { type: String, required: true },
    queryTextTruncated: { type: Boolean, default: false },
    // See the equivalent field on LakeAccessEventModel for what `immutable` does and does not
    // guarantee here (bypassable via `overwriteImmutable` or the raw driver) - the same guard
    // test covers both models.
    expiresAt: { type: Date, required: true, immutable: true },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    versionKey: false,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// TTL: always resolved SHORTER than the owning event's own TTL (see
// resolveLakeAccessQueryTextRetentionDays), so this collection sheds the more sensitive field
// first while the audit event's metadata lives on.
LakeAccessQueryTextSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const LakeAccessQueryTextModel =
  (mongoose.models[ModelName] as unknown as mongoose.Model<ILakeAccessQueryTextDocument>) ||
  mongoose.model<ILakeAccessQueryTextDocument>(ModelName, LakeAccessQueryTextSchema);
