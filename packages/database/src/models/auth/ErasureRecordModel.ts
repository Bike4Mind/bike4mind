import mongoose, { Model, model, Schema } from 'mongoose';

/**
 * Proof that an account was erased, kept so a database restore can be followed by erasing it again
 * (apps/client/server/users/reapplyErasure.ts, packages/scripts/src/reapplyErasures.ts).
 * Holds no raw id or email: `idHash` is a keyed HMAC of the user id (server-utils privacy/erasureHash).
 * Kept indefinitely as a minimal deletion marker, so it has no TTL.
 */
export type ErasureInitiator = 'admin' | 'self' | 'backfill';

export interface IErasureRecord {
  /** Keyed hash of the erased account id. */
  idHash: string;
  /** Fingerprint of the key behind `idHash`; a mismatch with the current key means a rotated secret. */
  keyId: string;
  /** The account's analytics pseudonym, when one was configured; a label for dry-run output. */
  pseudonym: string | null;
  erasedAt: Date;
  /** Which original path ran, so re-erasure repeats exactly what it removed. */
  initiatedBy: ErasureInitiator;
}

const ErasureRecordSchema = new Schema<IErasureRecord>(
  {
    idHash: { type: String, required: true, unique: true },
    keyId: { type: String, required: true },
    pseudonym: { type: String, default: null },
    erasedAt: { type: Date, required: true },
    initiatedBy: { type: String, enum: ['admin', 'self', 'backfill'], required: true },
  },
  { versionKey: false }
);

ErasureRecordSchema.index({ erasedAt: 1 });

export const ErasureRecordModel: Model<IErasureRecord> =
  (mongoose.models.ErasureRecord as unknown as Model<IErasureRecord>) ??
  model<IErasureRecord>('ErasureRecord', ErasureRecordSchema);

class ErasureRecordRepository {
  /** Upsert keyed on `idHash`: a re-erasure or a backfill keeps the first record. Joins an open transaction. */
  async record(input: IErasureRecord): Promise<void> {
    await ErasureRecordModel.updateOne({ idHash: input.idHash }, { $setOnInsert: input }, { upsert: true });
  }

  /** Insert records from an export, skipping ones already present. Returns how many were new. */
  async importMany(records: IErasureRecord[]): Promise<number> {
    if (records.length === 0) return 0;
    const result = await ErasureRecordModel.bulkWrite(
      records.map(r => ({ updateOne: { filter: { idHash: r.idHash }, update: { $setOnInsert: r }, upsert: true } }))
    );
    return result.upsertedCount;
  }

  /** Every record in erasure order, streamed. */
  cursor() {
    return ErasureRecordModel.find({}, { _id: 0 }).sort({ erasedAt: 1 }).lean<IErasureRecord>().cursor();
  }
}

export const erasureRecordRepository = new ErasureRecordRepository();
